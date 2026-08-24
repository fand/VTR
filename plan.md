# Plan: record ボタンのトラック配置を直す

## 現状の問題

`vtr-editor/src/renderer/src/App.tsx:184-222` の `maybeImportClip` が、録音停止のたびに
`d.tracks.push(track)` で無条件に新規トラックを作る。選択トラックも空き判定も見ていない。

関連する現状:

- 選択トラックはレンダラだけの状態 (`useSelection.ts`)。main は知らない。
- 重なり判定・空き探しのヘルパーは存在しない (ドラッグもペーストも重なりを許す)。
- クリップの開始位置は TD の `/vtr/clock` ビーコン由来 (`clips.ts:50-54` の `tlOffset`
  → `model.ts:83-86` の `alignClip`)。ビーコンが無ければ 0。

## 決定した仕様

1. 起点 = 一番上の選択トラック。選択が無ければ最上位トラック。
2. 起点から下に向かって、録音スパン `[offset, offset + len)` が完全に空いている
   トラックを探す。
3. 見つかればそこに `clips.push`。最後まで空きが無ければ末尾に新規トラック。
4. offset = ビーコン (`summary.tlOffset`) 優先、無ければ録音開始時の playhead。

判定は録音停止後の import 時に一度だけ行う。スパン全体で見るので、「rec 中に重なったら
下へ移動」と結果は同じになる。クリップは分割せず丸ごと動く。

## 変更内容

### 1. `src/renderer/src/timeline/model.ts` — 配置ヘルパーを追加

```ts
/** Does [start, end) overlap any clip on the track? */
export function trackIsFree(t: TrackState, start: number, end: number): boolean

/**
 * Index of the first track at or below `from` where [start, end) is free,
 * or -1 when every candidate is taken.
 */
export function findFreeTrack(
  tracks: TrackState[],
  from: number,
  start: number,
  end: number
): number
```

- 重なり判定は `c.offset < end && start < c.offset + clipLen(c)`。端の接触は重なりにしない。
- 浮動小数の誤差でくっついたクリップが「重なり」に見えないよう、小さな ε (1e-6) を許容。

### 2. `src/renderer/src/timeline/model.ts` — `alignClip` に fallback

```ts
export function alignClip(c: ClipInst, fallbackOffset = 0): ClipInst
// tlOffset があれば従来どおり。無ければ offset = max(0, fallbackOffset)
```

既存の呼び出し (`tracksFromProject` 系) は引数なしで従来動作のまま。

### 3. `src/renderer/src/useTapStatus.ts` — 録音開始時の playhead を捕まえる

- `opts` に `getPlayhead: () => number` を追加。
- `rec_started` (line 98-103) で `{ clip, playhead }` を App に渡す
  (新オプション `onRecStarted(clip, playhead)`)。
- `applySnapshot` 経由 (`rec_t` 由来) は開始時 playhead を復元できないので 0 fallback。

### 4. `src/renderer/src/App.tsx` — `maybeImportClip` を書き換え

```ts
const playheadRef = useRef(0)                    // useTransport の playhead をミラー
const recStart = useRef<{ clip: string; playhead: number } | null>(null)
```

`maybeImportClip` 内:

```ts
const fallback = recStart.current?.clip === clipPath ? recStart.current.playhead : 0
const clip = alignClip({ ... }, fallback)
const start = clip.offset
const end = start + clipLen(clip)

commit(`Recorded ...`, (d) => {
  const from = topmostSelectedIndex(d.tracks, selectedTrackIdsRef.current) // 無選択なら 0
  const i = findFreeTrack(d.tracks, from, start, end)
  if (i >= 0) d.tracks[i].clips.push(clip)
  else d.tracks.push({ id: newId(), clips: [clip] })
})
```

- `selectedTrackIds` は `tracksRef` と同じパターンで ref にミラーし、`useCallback` の
  依存を増やさない。
- 空プロジェクト (トラック 0 本) は `findFreeTrack` が -1 → 新規トラック。従来どおり。
- ログ行にどこへ置いたか (`→ track 2` / `→ new track`) を足す。

### 5. テスト

- `timeline/model.test.ts`: `trackIsFree` / `findFreeTrack` の単体テスト
  (空きあり / 前後に隣接 / 全部埋まって -1 / `from` が範囲外 / 端の接触は空き扱い)。
- e2e `e2e/record-placement.spec.ts` (新規): tap の debug ビルドで録音し、
  選択トラックに乗る / 重なると下のトラックへ落ちる / 下が無ければ新規トラックが生える、
  の 3 本。既存の `track-select.spec.ts`・`merge-clips.spec.ts` の作法に合わせる。

## 触らないもの

- main プロセスと tap/player のプロトコル。選択トラックはレンダラだけの状態なので
  IPC 追加なし。
- ドラッグ移動・ペーストの重なり許容。今回は録音配置のみ。

## 気になる点

`applySnapshot` 経由の import (エディタ起動前に録音が終わっていた等) は開始 playhead を
復元できないので、ビーコンが無いと offset 0 に落ちる。現状と同じ挙動なのでそのままにする。
