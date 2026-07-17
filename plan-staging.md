# Rec clip の cwd 汚染をなくす: userData staging + .oscproj バンドル

## Context

rec のたびに `clip-*.jsonl` が cwd に生成されて散らかる。`osc-tap.sock` / `undo.jsonl` / `session.jsonl` も cwd 固定。これをやめて:

- 未保存プロジェクト中の rec は `userData/recordings/`(staging)へ。macOS では `~/Library/Application Support/osc-editor/recordings/`
- プロジェクトは `.oscproj` バンドルディレクトリとして保存(`foo.oscproj/project.json` + `foo.oscproj/clips/*.jsonl`)。保存時に staging の参照 clip をバンドルへ move(collect)するので可搬
- 保存/オープン後の rec は直接 `bundle/clips/` へ(staging を経由しない)
- `osc-tap.sock` と `undo.jsonl` は userData へ(cwd 依存を全廃)
- macOS で `.oscproj` を Finder 上1個のファイルに見せる(LSTypeIsPackage)

## 設計の要点

- **`ProjectClip.file` は常にベア名**(`clip-x.jsonl`)。`"clips/x.jsonl"` に書き換えると edits のキー(file 名)と undo.jsonl の patch が旧名参照のまま壊れるため、リネームは絶対にしない
- **clip パス解決**(main 側、load/preview/export 共通): `bundle/clips/<file>` → `bundle直下/<file>`(旧フラットレイアウト互換)→ `staging/<file>` の順。最初に存在したものを使う
- **未参照 clip は消さない**: 削除→保存後もバンドル内に残す。undo.jsonl がファイル名で clip を参照するので、消すとアプリ再起動をまたいだ undo/redo が壊れる。掃除は将来の明示コマンド(Clean Up Project)で
- **undo.jsonl は userData にグローバル1本**(現状も実質そう。open 時 truncate する現挙動は維持)

## Changes

### 1. osc-tap (Rust)
- control API: `{"cmd":"start","dir":"/abs/path"}` を受け付ける(省略時は従来の `--outdir`)
- `control.rs`: start に optional dir をパース、`tap.rs`: `start_clip(dir: Option<PathBuf>)` → `start_recording` が `dir.unwrap_or(outdir)` に書く。`create_dir_all` も忘れず
- tests に dir 指定ケースを追加

### 2. `src/main/tap.ts`
- コンストラクタ: `workdir` → `dataDir`(sock/log)+ `outdir`(staging)に分離
- `sockPath = join(dataDir, 'osc-tap.sock')`、launchd plist の `WorkingDirectory` / `StandardErrorPath` も dataDir
- `start(dir?: string)`: `{"cmd":"start","dir"}` を送る

### 3. `src/main/index.ts`
- 起動時: `OSC_EDITOR_DATA_DIR` があれば `app.setPath('userData', それ)`(e2e 用)。`dataDir = app.getPath('userData')`、`stagingDir = join(dataDir, 'recordings')` を mkdir
- `tap:start` handler: プロジェクトが保存済みなら `join(bundleDir, 'clips')`、未保存なら staging を渡す
- `undo:*` IPC: workdir → dataDir
- `session:export` デフォルト出力先: 保存済みならバンドルの親ディレクトリ、未保存なら従来通り cwd
- open 系: `.oscproj` ディレクトリを受けたら `join(それ, 'project.json')` に正規化。旧来の `project.json` 直接指定も引き続き可(CLI 引数・Open ダイアログ両方)
- Save As ダイアログ: 拡張子 `oscproj`。選ばれたパスに mkdir してバンドル化

### 4. `src/main/project.ts`
- `resolveClip(file)`: 上記3段フォールバック解決を実装(loadProject / saveProject / merge で共用)
- `loadProject`: 解決に resolveClip を使う。edits サイドカーは clip の隣(解決先と同じ dir)
- `saveProject`(collect): 参照 clip のうち staging にあるものを `bundle/clips/` へ move(`renameSync`、EXDEV フォールバックで copy+unlink)。サイドカーも一緒に移動。移動後の file 名は変えない。戻り値で `Record<file, newPath>` を返す
- バンドル内の未参照 clip は削除しない

### 5. renderer
- `project:save` の戻り値(file→newPath)で ClipInst.path を更新(undo 履歴外の state 更新)
- それ以外は変更なし(`file` はベア名のまま)

### 6. electron-builder / macOS package 化
- `electron-builder.yml`: `mac.extendInfo` に CFBundleDocumentTypes(拡張子 `oscproj`、`LSTypeIsPackage: true`)
- 効くのはパッケージ版のみ。dev 実行では普通のディレクトリに見えるが動作は同じ

### 7. e2e
- 各 spec の launch env に `OSC_EDITOR_DATA_DIR: workdir` を追加(sock/undo/recordings がテスト tmp 配下に入り、実 userData を汚さない)
- 既存 spec は旧フラット project.json のまま通る(bundle直下フォールバックで解決)
- 追加テスト: rec→Save As(.oscproj)→staging から clips/ へ move されている・再オープンで再生できる・保存後の rec が bundle/clips/ に直接落ちる

### 8. docs
- `spec.md` / `README.md` の cwd 前提の記述をバンドル方式に更新

## Verification

1. `cargo test`(osc-tap/)+ `npm run build`(osc-editor/)
2. e2e 全部: `npx playwright test`(osc-editor/)
3. 手動: `npm run dev` → rec → cwd に clip が増えない → Save As で `.oscproj` 保存 → clip がバンドルに move → さらに rec → bundle/clips/ に直接落ちる → 再オープンで preview/export が動く。旧レイアウトの既存 project.json も開けること
