# TODO

リファクタのバックログ。ブランチ: `refactor/cleanup`（`fix/curve-resolution-diff` ベース）。
完了したものは git log を見る。

## e2e を回すときの注意

デフォルトポート（10010 / 10013）を使うテストは、`./run` の開発インスタンスが
上がっていると tap:off / player:off で落ちる（bundle, export-preview, open-file,
ports-seek, single-instance の計7本）。フルスイートの前に開発アプリを終了する。

## バックログ（調査で出たもの。未合意）

- **Timeline/CurvePanel のピンチ + マーキー/ドラッグのジェスチャーフック** —
  uiScale の作業から先送りしたもの。ピンチのアンカー処理のタイミングは意図的に違う
  （Timeline は親でクランプ、CurvePanel はローカル）。pointercancel の扱いも意図的に違う
  （Timeline は中断、CurvePanel はコミット）。この違いを明示できる設計になって初めて着手する価値がある。
