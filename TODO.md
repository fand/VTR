# TODO

- VJアプリ側からrecordのstart, stopもコントロール出来るようにしたい
  - clock用のportでclock以外も受け取れるようにする (`/rec/start`, `/rec/stop` など？もっと良いアイデアあれば教えて)
  - これらのイベントにclock情報も含めるようにすることで、rec開始時からsyncできそう
- [x] GitHub Actionsでビルド/テストしたい
  - `.github/workflows/ci.yml`: cargo test (macOS) / lint+typecheck+unit (Linux) / playwright e2e (macOS)
- [x] README更新
- TouchDesignerで使用するスクリプト/tox作成
  - 再生用と記録用が必要？
- osc-tapの本番相当の計測方法(現状: soakテストで 120Hz gap中央値 8.333ms / p99 8.371ms / ロス0)
