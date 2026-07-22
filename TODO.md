# TODO

- curveの最初のdata point以前に値を延長する
  - 例えば、t=10~20 の区間にdata pointを持つcurveの場合、t=1にseekしたらt=10と同じ値を返してほしい
  - 連続seek時、重複する値は送信を避けるなどができるはずなので留意せよ
- toxの不要になったパラメータは削除せよ
- osc-tapはvtr-tapにrename
- osc-editorはvtr-editorにrename
- vtr-tapとvtr-playerを `crates/` 下に並べて置きたい
  - vtr-editorも同じレベルに置く？要検討
