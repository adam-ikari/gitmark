---
id: github-app-account-auth
title: "GitHub 帐号认证：GitHub App + PKCE，可静默续期"
category: decision
status: active
tags: [GitHub App, PKCE, 静默续期, 取代 PAT]
created: "2026-10-05T09:21:56"
updated: "2026-10-05T09:52:38"
---

<!-- compiled_truth -->
<current best understanding — replace this with the real content>

## Timeline

- time: 2026-10-05T09:21:56
  kind: decision
  summary: "Created this page: GitHub 帐号认证：GitHub App + PKCE，可静默续期"
  source: "查证 GitHub 官方文件后推翻 device flow 2026-10-05"
  affects: [github-app-account-auth]

- time: 2026-10-05T09:52:38
  kind: note
  summary: "The EXPO_PUBLIC_ prefix means the client secret is inlined into the shipped bundle by design; the name is the hazard, not the mechanism, and is documented as such at the read site"
  source: app/github/signIn.ts 2026-10-05
  affects: [github-app-account-auth]
