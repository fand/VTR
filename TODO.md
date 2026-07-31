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
Emit が types を運ぶ。conformance_osc_encode.rs）。

## 既知の問題（このブランチ以前から。2026-07-30 に確認）

curve 系の e2e 5本が `main` でも落ちる（ピクセル操作系:
curve-edit.spec.ts のノットドラッグ、curve.spec.ts のトランスフォームボックス /
スナップ / ペンシル / マーキー。いずれも `toHaveCount` の不一致）。
このブランチが原因ではない。別途調査が必要。

## バックログ（調査で出たもの。未合意）

- **Rust の unix socket JSONL 制御サーバを統一** — tap はロングポーリングの
  `wait` を別スレッドで返すが、player の `watch` は接続全体を約1秒ブロックする
  （head-of-line）。vtr-core に共有の `jsonl_server::serve(path, handler)` を置く
  （stale socket の削除、id のエコー、不正 JSON への応答、別スレッド応答の仕組み）。
  切り替える前に、editor の player クライアントが順不同の応答を許容するか確認する
  （tap クライアントは許容する）。
- **ControlError enum（Rust）** — 現状エラーの書き方が3種類ある: 境界での anyhow、
  tap のアクターハンドルを通る `Result<T, String>`、両方の制御レイヤーにある
  自由形式の `json!({"ok":false,...})`。
  （"writer thread gone" のリテラルは `Handle::ask` に集約済み。）
- **Timeline/CurvePanel のピンチ + マーキー/ドラッグのジェスチャーフック** —
  uiScale の作業から先送りしたもの。ピンチのアンカー処理のタイミングは意図的に違う
  （Timeline は親でクランプ、CurvePanel はローカル）。pointercancel の扱いも意図的に違う
  （Timeline は中断、CurvePanel はコミット）。この違いを明示できる設計になって初めて着手する価値がある。
