---
id: sync-chain-wiring
title: "同步鏈路的分層與接線"
category: decision
status: active
tags: [sync, 分層, 重入保護]
created: "2026-10-05T04:56:16"
updated: "2026-10-05T06:25:52"
---

<!-- compiled_truth -->
<current best understanding — replace this with the real content>

## Timeline

- time: 2026-10-05T04:56:16
  kind: decision
  summary: "Created this page: 同步鏈路的分層與接線"
  source: "實作 sync 鏈路 2026-10-05"
  affects: [sync-chain-wiring]

- time: 2026-10-05T05:01:26
  kind: evidence
  summary: "Implemented the full sync chain; the adapter integration test caught a real bug (isomorphic-git passes absolute paths, so the resolver must not re-prefix the root)"
  source: "app/git/expoFs.ts, app/git/fsIntegration.test.ts 2026-10-05"
  affects: [sync-chain-wiring, git-fs-adapter-contract]

- time: 2026-10-05T06:25:52
  kind: reversal
  summary: "The warning that the working tree and .git must share one adapter was written while the code had four separate expo accessors; consolidated onto expoFile/expoDirectory"
  source: "app/git/notes.ts, app/git/gitNotes.ts, app/git/credentials.ts, app/screens/NoteListScreen.tsx 2026-10-05"
  affects: [sync-chain-wiring, expo-boundary-no-casts]
