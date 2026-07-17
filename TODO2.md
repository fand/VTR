# TODO2

- repo名を `VTR` に統一
  - desc: `VJs' Timeline Recorder`
- File MenuにOpen Recentを追加
- repo rootからアプリ起動するスクリプトを追加して
  - `./run` とか？あるいはjustfileでも良いね
- VJアプリ側からrecordのstart, stopもコントロール出来るようにしたい
  - clock用のportでclock以外も受け取れるようにする (`/rec/start`, `/rec/stop` など？もっと良いアイデアあれば教えて)
  - これらのイベントにclock情報も含めるようにすることで、rec開始時からsyncできそう
- GitHub Actionsでビルド/テストしたい
- README更新
