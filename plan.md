# osc-mtr 実装プラン

## 決定事項

- renderer: React + TypeScript(electron-vite)
- MVP: osc-tap は editor の子プロセス。クラッシュ時は editor が再spawn。launchd化は最終フェーズ
- プレビューOSCは editor から TD :10011 へ直接送信(tapを経由しない)
- 制御API(specの未決を仮決定): unix domain socket + JSON Lines
- clipファイル命名: 録音開始の壁時計時刻 `clip-YYYYMMDD-HHmmss.jsonl`。tapが命名しstart応答でパスを返す

## リポジトリ構成

```
osc-mtr/
  spec.md
  plan.md
  osc-tap/       # Rust crate (bin)
  osc-editor/    # Electron app (electron-vite + React + TS)
```

## Phase 1: osc-tap コア

- CLI: `osc-tap --listen 10010 --forward 127.0.0.1:10011 --beacon 10012 --control <sock> --outdir <dir>`
- スレッド構成:
  - recv thread: 受信 → 単調クロックで打刻 → 無改変転送 → (生バッファ, t, ビーコンスナップショット) をchannelへ
    - パースや書き込みはhot pathに置かない
  - writer thread: rosc でパース(バンドル展開、型変換、blobは警告+スキップ)→ tl 計算 → JSON行追記 + flush
  - beacon thread: `/tap/timeline` 受信、(tl値, 到着Instant) を共有stateに更新
  - control thread: unix socket。`{"cmd":"start"}` / `{"cmd":"stop"}` / `{"cmd":"status"}`
- tl = ビーコン値 + (イベント打刻 − ビーコン到着)。未受信ならフィールド省略
- session_start(wall, routes)/ session_end 行の出力
- 確認: 送信スクリプト(python-osc等)→ clip.jsonl の内容・転送先での受信を検証。TD不要

## Phase 2: osc-tap 堅牢性

- 簡易soakテスト: 120Hz×数分 + バースト送信で、取りこぼし0・メモリ安定を確認するスクリプト
- 受信バッファ拡大(SO_RCVBUF)、channel溢れ時の方針(ブロックせずカウントして警告)
- 詳細なテスト/計測方法は別途議論(spec通り)

## Phase 3: editor スキャフォールド + 録音

- electron-vite + React + TS でscaffold
- main process:
  - tap の spawn / 監視 / 再spawn、終了時のkill
  - unix socket クライアント、IPC(contextBridge)でrendererへ
  - cwd を作業ディレクトリとして扱う
- UI: header(timecode、レコード開始/停止)+ 空のtracks
- レコード開始 → tap start → 停止 → 新規trackにclipが載る(まずは矩形表示のみ)

## Phase 4: timeline編集

- プロジェクトモデル(非破壊。jsonlは編集しない):
  ```json
  { "tracks": [ { "clips": [ { "file": "clip-....jsonl", "offset": 12.3, "trimIn": 0.0, "trimOut": 45.6 } ] } ] }
  ```
  - offset = timeline上の配置秒、trimIn/trimOut = clip内ローカル秒
- clipのmove/trim/削除、timelineのzoom/scroll
- 自動align: `offset = median(tl − t)` で算出して配置(tl無しclipは対象外)
- project.json の保存/ロード(cwd直下、起動時ロード)
- clip内イベントの簡易可視化(アドレス別の点表示)は余裕があれば

## Phase 5: 書き出し + プレビュー

- 書き出し: 全clipのイベントを timeline秒へ写像 → trim範囲外を除外 → ソート → session.jsonl(session_start/end付き)
- プレビュー: transport(play/pause/seek、playhead描画)
  - main processで先読みスケジューラを回し、osc-min等でエンコードして TD :10011 へUDP送信
  - 精度は確認用途のベストエフォート(最終レンダーはTD側ファイル駆動)
- 確認: 書き出したsession.jsonlをTDのOSC_REPLAYERで再生

## Phase 6: launchd化 + 仕上げ

- plist生成、`launchctl bootstrap`/`kickstart` で起動、editor正常終了時に `bootout`
- KeepAlive(Crashed)で自動復旧、editorはsocket再接続
- tap強制killでの復旧・記録継続を確認

## フェーズ間の依存

Phase 1 → 3 → 4 → 5 が主経路。2 と 6 は独立して差し込み可能。
