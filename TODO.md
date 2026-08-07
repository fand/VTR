# TODO

- timelineが長いとき、詳細にzoom inできない
  - timeline durationに関わらず、最大zoomではframeが見えるべき
- curve editorにvalueのlimit機能がほしい
  - snapボタンの横にlimitボタンを追加
  - 有効のとき、data pointのdragは常に0~1の範囲に限定される
    - 既存の0~1範囲外のdata pointには影響しない
- snapが有効のとき、x方向のsnap単位はgridではなく、常にこうなってほしい:
  - timeline editor: clip境界 or 秒
  - curve editor: clip境界 or 付近のdatapoint or 秒
- Cmd+scrollでtimelineのzoom倍率変更したい
- clipをmergeする機能
  - 複数trackの複数clipを選択して右クリック → "Merge" で一つのclipに統合する
- Trackはdragでsortしたい
- clipを縮めるだけじゃなく、伸ばしたい
- projectを別のprojectにimportする機能  
  - importされたtrack, clipは `import_<original_project_name>_` prefixがついてほしい
