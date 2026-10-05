---
id: android-release-signing
title: "Android 發布簽名：不能用 debug key"
category: decision
status: active
tags: [發布, 簽名, 資料遺失]
created: "2026-10-05T08:03:02"
updated: "2026-10-05T09:52:38"
---

<!-- compiled_truth -->
<current best understanding — replace this with the real content>

## Timeline

- time: 2026-10-05T08:03:02
  kind: decision
  summary: "Created this page: Android 發布簽名：不能用 debug key"
  source: "發布 v0.1.0-preview.1 2026-10-05"
  affects: [android-release-signing]

- time: 2026-10-05T09:52:38
  kind: note
  summary: "Audited the public repository for leaked signing material: nothing tracked, no keystore or password in any commit. Added *.keystore/*.pass to .gitignore because a key in the repo ROOT was not ignored (only android/ was), plus a test that fails if a release key appears in the working tree"
  source: "git log --all scan, .gitignore, app/git/signingKeyGuard.test.ts 2026-10-05"
  affects: [android-release-signing]
