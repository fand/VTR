# TODO

リファクタのバックログ。ブランチ: `refactor/cleanup`（`fix/curve-resolution-diff` ベース）。

完了済み: デッドコード削除、write_line のスロットル、playhead キーの統一、
curve のゴールデンフィクスチャ（+ serde_json float_roundtrip 修正）、vtr-core crate、
ControlChannel/ChildSupervisor、CurvePanel の分解、uiScale
（zoomSlider + useElementSize）、オーバーレイ変換を shared/edits.ts へ、
pick_latest_or_earliest（vtr-player/src/pick.rs。resolve_at と curve_group_args が
共有。clamp と tie を conformance ケースで固定）、
editor main の分割（register*Ipc + AppContext）、ダイアログの seam
（dialogs.ts / nativeDialogs.ts）、shared/jsonl.ts + session_lines.jsonl
ゴールデンフィクスチャ、App.tsx の分解（useShortcuts / useSelection /
useProjectFile / useTransport / useTapStatus + components/、1729→858行）、
vtr-tap/src/tap.rs の分割（tap/ 以下に beacon / notify / eventlog / jsonl /
recv / ctl / writer。1455行 → mod.rs 147行）、グリッド/目盛りのステップ計算の統合
（timeline/model.ts の pickStep + TIME_TICK_MIN_PX）、
OSC↔JSON コーデックのラウンドトリップ（vtr-core/src/osc_json.rs が両方向を所有。
Emit が types を運ぶ。conformance_osc_encode.rs）、
unix socket JSONL 制御サーバの統一（vtr-core/src/jsonl_server.rs。
長ポーリングは `Reply::Defer` で別スレッドに逃がす。player の head-of-line を解消し、
editor の watch 専用接続を廃止）、`ControlError`（vtr-core/src/jsonl_server.rs。
ハンドラは `ControlResult` を返し、`ok` / `error` / `id` の封筒は
`jsonl_server::response` だけが組む。文言は `Display` に集約。
`From<String>` でアクターハンドルの結果に `?` が使える）、
curve 系 e2e 5本の修正（`useCurveInteraction` の TDZ。レンダー中に走る `selBox` が
`interactiveProps` を初期化前に呼んでいた。選択が2点以上になった瞬間に
レンダーが throw して React がツリーごと落ちるため、
トランスフォームボックス / スナップ / ペンシル / マーキー / ノットドラッグが全滅していた）。

## e2e を回すときの注意

デフォルトポート（10010 / 10013）を使うテストは、`./run` の開発インスタンスが
上がっていると tap:off / player:off で落ちる（bundle, export-preview, open-file,
ports-seek, single-instance の計7本）。フルスイートの前に開発アプリを終了する。

## バックログ（調査で出たもの。未合意）

- **Timeline/CurvePanel のピンチ + マーキー/ドラッグのジェスチャーフック** —
  uiScale の作業から先送りしたもの。ピンチのアンカー処理のタイミングは意図的に違う
  （Timeline は親でクランプ、CurvePanel はローカル）。pointercancel の扱いも意図的に違う
  （Timeline は中断、CurvePanel はコミット）。この違いを明示できる設計になって初めて着手する価値がある。
