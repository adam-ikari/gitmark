---
id: expo-boundary-no-casts
title: "平台邊界不得 cast 掉 expo 型別"
category: decision
status: active
tags: [typecheck, expo-file-system, 邊界]
created: "2026-10-05T06:25:02"
updated: "2026-10-05T07:12:23"
---

<!-- compiled_truth -->
<current best understanding — replace this with the real content>

## Timeline

- time: 2026-10-05T06:25:02
  kind: decision
  summary: "Created this page: 平台邊界不得 cast 掉 expo 型別"
  source: "接 CI 時實測抓到兩個被 cast 隱藏的 bug 2026-10-05"
  affects: [expo-boundary-no-casts]

- time: 2026-10-05T07:12:23
  kind: evidence
  summary: "The boundary guard and the no-cast rule were confirmed by real CI runs, including a deliberate failure probe that correctly turned CI red"
  source: "runs 37274274086, 37275741266, 37276191002 2026-10-05"
  affects: [expo-boundary-no-casts]
