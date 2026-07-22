# TODO

- TD tox rework — Rec page を `/vtr/*`+listen port に、Play page を vtr-player の同期クエリクライアントに(docs/tasks/tox-rework/spec.md)
- editor preview の vtr-player 委譲(resolver を一本化)

Done: resolver-server (vtr-player) 実装 — protocol v2 (`/vtr` namespace、ctrl port 廃止、echo port)、同期クエリ API、パンチイン。プロトコルは README「OSC control」参照

Done: tl-sync — td/editor 双方向シーク同期(transport を単一権威 playhead に、origin/gen エコー抑制、watch long-poll、tox `sync` モード)。tox バイナリ再ビルドと TD 実機検証は残(docs/tasks/tl-sync/)

- curve editorにもplayheadを表示し、seekできるようにする
