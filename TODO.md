# TODO

- [x] repo名を `VTR` に統一
  - desc: `VJs' Timeline Recorder`
- [x] File MenuにOpen Recentを追加
- repo rootからアプリ起動するスクリプトを追加して
  - `./run` とか？あるいはjustfileでも良いね
- VJアプリ側からrecordのstart, stopもコントロール出来るようにしたい
  - clock用のportでclock以外も受け取れるようにする (`/rec/start`, `/rec/stop` など？もっと良いアイデアあれば教えて)
  - これらのイベントにclock情報も含めるようにすることで、rec開始時からsyncできそう
- GitHub Actionsでビルド/テストしたい
- README更新
- TouchDesignerで使用するスクリプト/tox作成
  - 再生用と記録用が必要？
- osc-tapの本番相当の計測方法(現状: soakテストで 120Hz gap中央値 8.333ms / p99 8.371ms / ロス0)
