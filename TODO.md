# TODO

- 最後のclipをドラッグするとtimelineの描画範囲が変更されてしまう
  - 例: dur=34minのtimelineで、34min位置にあるclipを30minに移動すると、0-30min しかtimeline viewに描画されない
  - timelineの描画範囲がdurではなくて最後のclip位置になってしまっている？
- pinch zoom in/outで、zoomの基準点がマウスカーソル位置になっていない
- Cmd+scrollでtimelineのzoom倍率変更したい
- clipをmergeする機能
  - 複数trackの複数clipを選択して右クリック → "Merge" で一つのclipに統合する
- Trackはdragでsortしたい
- projectを別のprojectにimportする機能  
  - importされたtrack, clipは `import_<original_project_name>_` prefixがついてほしい
