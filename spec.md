# osc-mtr: OSC 記録/再生システム 仕様

ライブVJパフォーマンスのアーカイブ動画を作成するために、リアルタイムで入力されるOSCイベントを記録して連結/編集し、一本のOSCログを生成するシステムを開発する。
OSCイベントの記録は一発通しで行われることも、複数回にわけて行われることもあり、本システムではDAWのようにOSCイベントの記録を編集できるものとする。
出力されたOSCログはTouchDesignerで再生し、高品質でのオフラインレンダリングに利用される。

## 成果物

本システムは以下の部品で構成される:

- osc-tap
  - OSC入力を記録しつつ、VJアプリに転送するプロキシ
  - launchd (macOS) のuser agentとして常駐させる。クラッシュ時はOSが自動再起動(KeepAlive)
- osc-editor
  - osc clipを連結/編集して書き出すためのGUIアプリ
  - osc-tapのライフサイクルも制御する(起動 = `launchctl bootstrap`/`kickstart`、正常終了時は `bootout` で明示停止)

## トポロジ

```
TouchOSC ──► osc-tap (:10010) ──生UDP──► TD (:10011)
                │
                ▼
          clip.jsonl ──► osc-editor ──► session.jsonl
                                              │
                                TD OSC_REPLAYER(フレームロック)
                                              │
                                non-realtime レンダー + ffmpeg mux
```

- 入力は1ポートのみ対応(将来の複数化は考慮しない)
- 受信/送信/clockポート番号はeditorのheaderで変更できる(project.jsonに保存。変更時はosc-tapを再起動)
- osc-tap は **直列インターセプトプロキシ**: 受けたデータグラムをまず無改変で転送し、その後パース済みコピーをログする。転送で再エンコードしてはならない。
- 最終レンダーの再生は**TouchDesigner内のファイル駆動**(フレームロック)。最終レンダー時にアプリがOSCを流すことはない(エディタのプレビュー再生は別。後述)
- ホスト(TD等)からosc-tapへタイムラインビーコン `/clock` が送られる(後述)

## osc-tap要件

- Rustで実装
- ソケットごとに専用スレッド。転送より先に**単調増加クロック**で到着時刻を打刻する。記録タイミングは TD の cook レートから独立していること
- 高負荷時でも取りこぼし/クラッシュしないこと。テスト・計測方法は別途議論
- 1メッセージ=1 JSON行を追記し、毎行 flush(クラッシュしても何も失わない)
- editorへ制御API(clip録音の開始/停止、状態取得)を提供する。方式: unix domain socket + JSON Lines

### タイムラインビーコン(tl)

- ホストがmasterタイムライン位置を約10Hzで専用ポートに送る:
  `/clock <t: float> [rate: float]`
  - `t`: masterタイムライン秒。`rate`: 進行速度(1.0=再生、0.0=停止、負=逆再生)。省略時 1.0
  - 送信元はTDに限らない。この契約を満たせば他のVJソフト/ブリッジも使える(TDなら `/project1` の位置をExecute DATで送る)
- ビーコンは転送もイベント記録もしない。各イベントに `tl` を刻むためだけに使う
- `tl` は最後に受信したビーコンからの外挿で求める:
  `tl = t_beacon + rate × (イベント打刻 − ビーコン到着)`
  過去のビーコンだけで求まる(未来の値は不要)。10Hz量子化でイベント順が潰れるのを防ぎ、rateにより停止/スロー/逆再生中も正しく凍結・追従する
- ビーコン未受信のイベントには `tl` を付けない(フィールド省略)
- ビーコンは必須運用としたいが、tl無しでも記録は成立する
- 録音中のシーク(clip内のtl不連続)は非対応。テイク間の巻き戻しは問題ない(clipごとに独立にalignされる)

## osc-editor要件

- Electronで実装
- DAWモデルを採用: UIはheaderとtracksで構成
- headerにはtimecode、レコード開始/停止ボタン、プレビューボタン、書き出しボタンを持つ
  - レコード開始で新規トラックにclipを録音
- tracksにはtrackが縦に複数並ぶ
- trackには複数のclipを並べられる
  - clip = 1 record (jsonlファイル)
  - clipは手動でmove/trim/削除が可能
- 自動align: 任意のタイミングで実行できるコマンド。`tl` を持つclipをTDタイムライン上の位置に配置する。`tl` の無いclipは対象外
- プレビュー: timelineに沿ってeditorがOSCをTDへリアルタイム送信し、編集結果を確認する(最終レンダーには使わない)
- プロジェクト(track/clip配置)はJSONで保存し、editor起動時にロードする
- 作業ディレクトリ = CLI起動時のcwd。clip.jsonl、プロジェクトJSON、session.jsonl はここに置く

## ログ形式(JSONL)— アプリ↔TD の契約

```
{"type":"session_start","t":0.0,"wall":"2026-07-16T21:00:00+09:00","host":"127.0.0.1","routes":["10010->10011"]}
{"t":12.345,"tl":34.512,"port":10010,"a":"/fader_foam_speed","args":[0.42]}
{"t":12.361,"tl":34.528,"port":10010,"a":"/kick-on","args":[]}
{"type":"session_end","t":123.4}
```

- `t`: セッション開始からの秒数(単調増加)。`wall`: 録音開始の壁時計時刻(ISO 8601)。`port`: 受信ポート。`a`: OSC アドレス。`args`: パース済み引数
- 対応型: float / double / int / string / bool / color / impulse。blobは非対応(遭遇したら警告してスキップ。転送は生データグラムのままなので影響なし)
- `tl`: 到着時点のTDタイムライン秒(ビーコン由来、外挿込み)。任意フィールド
- OSC timetagは `tl` の代替にしない(timetagは送信側の壁時計(NTP)であり、TDタイムライン位置を含まない。"immediately" 固定で送るアプリも多い)
- 1ファイル 1セッション
- OSC バンドルはパース時に個別メッセージへ展開する

## 書き出し

- 全trackの全clipのイベントをeditor timeline上の時刻へ写像し、時刻順にソートして単一の `session.jsonl` を出力する
- 出力の `t` はeditor timeline上の秒。セッション長 = timelineの長さ(editorで設定可能。コンテンツがそれより長い場合はコンテンツ末尾まで)
- 同一アドレスへの重複書き込みは解決しない(時刻順に並べるだけ。TD側で自然に後勝ちになる)

## 未決事項

- osc-tapの本番相当の計測方法(現状: soakテストで 120Hz gap中央値 8.333ms / p99 8.371ms / ロス0)
