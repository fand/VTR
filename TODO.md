# TODO

- Curve Editorの縦軸のラベルがおかしい。最大値が0.16になってる？
- property (curve) ごとにアサインしてる色、バリエーションが少なすぎる。もっと増やして
  - 動的に生成するか事前にリストをハードコードするか、良い方で
- "tap up" "no clock" などの状態はheaderに表示したい
  - in, out, clock のport表示と合わせてレイアウト調整したい。gridっぽく
  
イメージ:

```
"tap on"      in    [10010]     out [10011]
"no clock"    clock [.....]
```
