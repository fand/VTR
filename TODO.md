# TODO

- [x] VJアプリ側からrecordのstart, stopもコントロール出来るようにしたい
  - clockポートで `/rec/start [tl] [rate]` / `/rec/stop` を受信 (editorが死んでいても録画可)
  - `/rec/start` のtl引数でrec開始時からsync。設計: `docs/tasks/rec-msg/spec.md`
- [x] GitHub Actionsでビルド/テストしたい
  - `.github/workflows/ci.yml`: cargo test (macOS) / lint+typecheck+unit (Linux) / playwright e2e (macOS)
- [x] README更新
- TouchDesignerで使用するスクリプト/tox作成
  - 再生用と記録用が必要？
- osc-tapの本番相当の計測方法(現状: soakテストで 120Hz gap中央値 8.333ms / p99 8.371ms / ロス0)
