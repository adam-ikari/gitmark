---
id: github-pat-git-transport
title: "Git 傳輸走 isomorphic-git + GitHub REST"
category: decision
status: active
tags: [純 JS, 無原生 git 依賴]
created: "2026-10-04T13:39:43"
updated: "2026-10-05T09:21:57"
---

<!-- compiled_truth -->
# Git 傳輸：isomorphic-git + GitHub REST/SmartHTTP + PAT

## 決定
筆記的 git 儲存層用 **isomorphic-git**（純 JS git 實作），搭配自寫的 **以 `fetch` 實作的 HTTP client**，認證用 **Personal Access Token**。不使用 SSH，不依賴原生 git 函式庫，也不依賴 Node 內建模組。

## 為什麼
- React Native 沒有 git。選項只有三種：(a) 編譯 libgit2 成原生模組，(b) 依賴裝置上的 git 二進位，(c) 純 JS。只有 (c) 能跨平台、能用 Node 直接跑測試。
- isomorphic-git 自帶 `merge()` 並使用 `diff3` 套件，所以套件本身在這條路線上已被驗證；我們自己寫合併是為了拿到可測試的 diff3 與更適合筆記的策略（見 [[safe-auto-merge]]）。
- PAT 讓「憑證在哪」變成一個單純的 app 設定。

## 實測驗證（2026-10-04，先驗證再實作）

1. **`file://` 與本機路徑不受支援** → `UnknownTransportError`。isomorphic-git 只支援 Smart HTTP / SSH。
   後果：本機 git 資料夾**不能**當測試用 remote，測試必須走真實 HTTP 或注入假 transport。
2. **自訂 transport 的 `body` 必須是 `AsyncIterator<Uint8Array>`**。回傳 Buffer、或回傳 Buffer 的函式，症狀是
   誤導性的 `EmptyServerResponseError: Empty response from git server.`，不會提示型別錯誤。
   契約已對照 `isomorphic-git/http/web` 實作確認。
3. **Node 內建 http client 不能用於 RN**（依賴 `node:http`）。行動端必須自備以 `fetch` 實作的 client，
   回傳 `{statusCode, headers, body: asyncIterator}`。

以 `octocat/Hello-World` 實測通過 clone / listFiles / resolveRef / log。

## 約束
- **token 不進 git**。憑證存 OS keystore（`expo-secure-store`），不寫進 repo 設定檔、不進 commit、不進 log。
- 絕不記錄 token 到 console/logcat，錯誤訊息要過濾。
- 最小權限：只需對目標單一 repo 的寫入權限。
- Git 層必須接受可注入的 transport 與檔案系統，這樣測試能跑在假 remote 上，未來換 Gitea/GitLab 只需換 client。

## 後果
- 大檔案（附件）走 LFS 不在第一階段範圍；先限制單檔大小並在 UI 提示。
- 首次 clone 走 HTTP 抓 pack，需做進度回報與可取消。
- **不使用 isomorphic-git 內建的 `merge()`**：它產生的介面與衝突報告不符合我們要的三選一處理流程，
  且我們需要控制「插入不衝突」這條策略。改為自己實作 diff3 + 呼叫核心層的 `merge3`。


## Timeline

- time: 2026-10-04T13:39:43
  kind: decision
  summary: "Created this page: Git 傳輸走 isomorphic-git + GitHub REST"
  source: user-confirmed 2026-10-04
  affects: [github-pat-git-transport]

- time: 2026-10-04T13:39:59
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: user-confirmed 2026-10-04
  affects: [github-pat-git-transport]

- time: 2026-10-04T16:43:53
  kind: decision
  summary: "Verified against real GitHub: file:// is unsupported, and the transport body must be an AsyncIterator of Uint8Array"
  source: probe 2026-10-04
  affects: [github-pat-git-transport]

- time: 2026-10-05T09:21:57
  kind: reversal
  summary: "Replaced the personal access token with GitHub App sign-in (authorization code + PKCE); the PAT field is gone. Chose the App over an OAuth App because the narrow grant matches the minimal-permission principle already recorded here"
  source: "core/github/auth.ts, app/github/signIn.ts 2026-10-05"
  affects: [github-pat-git-transport, github-app-account-auth]
