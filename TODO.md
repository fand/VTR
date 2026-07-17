# TODO

- Play/Pauseボタン、RECボタンはアイコンだけにする
  - borderもBGもlabelも不要 (hover時だけbgをハイライト)
- "osc-mtr" の横に file メニューを追加
  - Open (Cmd+O) を押したらFileダイアログを開き、projectファイルをロードできる
  - Save (Cmd+S) を押したらFileダイアログを開き、projectを保存
  - Save as (Shift+Cmd+S) で別名保存
- アプリ起動時、デフォルトでは空のprojectを開くようにする
  - cli引数で第一引数としてファイルパスがわたってたらprojectとして開く
  - ファイルのパースなどに失敗したらエラーメッセージを表示しつつ空のprojectを開く
- window titleをosc-mtrに変更
  - projectファイルを開いているとき、window titleを "osc-mtr - project.jsonl" とかにする
  - 未保存の変更がある時は "(edited)" みたいなsuffixをつける
