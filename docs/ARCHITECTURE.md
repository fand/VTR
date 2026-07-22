# Architecture

データフロー図。矢印はすべてデータ(ペイロード)の進む向き。
ポート・ソケットはコードの既定値。

## 全体像

```
TouchOSC ──▶ osc-tap ──▶ clips/*.jsonl ──▶ osc-editor ──▶ session.jsonl ──▶ vtr-player ──▶ TouchDesigner
 (操作)      (記録)                        (編集/配置)                        (再生/解決)      (映像)
```

## ① ライブ / 録音経路

```
TouchOSC ── app OSC + /vtr/* ──▶ osc-tap ── app OSC そのまま転送 ──▶ TouchDesigner
            (UDP :10010)           │            (UDP :10011)
                                   ├─▶ clips/*.jsonl に記録 (tl 付き JSONL)
                                   ├─▶ /vtr/* リレー ──▶ vtr-player (UDP :10013)
                                   └─▶ rec 通知 ──▶ vtr.tox record モード (UDP :10014)

vtr.tox ── /vtr/clock ビーコン (tl, rate) ──▶ osc-tap (UDP :10010)
```

- `/vtr/clock` で TD タイムライン時刻(`tl`)をイベントに刻印。
  `/vtr/rec/start [tl]` が公式の同期開始手段。
- `/vtr/*` はアプリへ転送されず、記録もされない。

## ② 編集 / プレビュー (osc-editor)

```
clips/*.jsonl ──▶ osc-editor ──┬─▶ session.jsonl エクスポート
                               └─▶ inline session load (routes 付き) + transport 書込 ──▶ vtr-player
                                     (unix socket vtr-player.sock)

vtr-player ── プレビュー OSC (③ の再生経路と同一) ──▶ TouchDesigner (UDP :10011)
```

- editor は osc-tap と vtr-player を spawn・監視する
  (tap は osc-tap.sock の JSON Lines API、player は stdin close で終了)。
- プレビュー再生は player に委譲: editor は merge した project を routes 付きで
  inline load し、transport を seek/play するだけ。OSC を出すのは player の
  emit loop のみ(resolver 一本化 — preview と本番再生が同一挙動)。
  停止中の seek も catch-up が dedup 付きで TD へ届く。
- sync クライアント(TD)は同じ transport に追従する。

## ③ 再生 / 同期 (vtr-player)

```
session.jsonl ──▶ vtr-player ──┬─▶ 再生 OSC ──▶ TouchDesigner (routed port → UDP :10011)
                               ├─▶ 差分イベント ──▶ vtr.tox player モード
                               │     (unix socket; TD が毎フレーム resolve 問い合わせ、応答で受取)
                               └─▶ rec 状態エコー ──▶ TouchOSC (送信元IP :9000)

osc-tap ── /vtr/play|stop|seek リレー ──▶ vtr-player (UDP :10013)
osc-editor / vtr.tox(sync) ── transport 書込 (seek/play, gen+origin) ──▶ vtr-player
```

- resolve は pull 型: リクエストは TD 発だが、データ本体(差分イベント)は
  player → TD に流れる。TD は cook 直前に応答までブロックするので
  1 cook = 1 状態が保証され、オフラインレンダリングも正確。
- push transport が唯一の正のプレイヘッド。editor / TD(`sync`) /
  コントローラのどこから seek・play しても `gen` + `origin` で他へ伝播、
  エコーは origin で抑制。

## ポートまとめ

| 経路 | 手段 |
|---|---|
| TouchOSC → tap | UDP :10010 |
| tap → TD (転送) / player → TD (再生・プレビュー) | UDP :10011 |
| tap → player (/vtr/* リレー) | UDP :10013 |
| tap → TD (rec 通知) | UDP :10014 |
| player → コントローラ (rec エコー) | UDP 送信元IP:9000 |
| editor ↔ tap / editor・TD ↔ player | unix socket (osc-tap.sock / vtr-player.sock) |
