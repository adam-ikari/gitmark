---
id: github-pat-git-transport
title: "Git 傳輸走 isomorphic-git + GitHub REST"
category: decision
status: active
tags: [純 JS, 無原生 git 依賴]
created: "2026-10-04T13:39:43"
updated: "2026-10-04T13:39:59"
---

<!-- compiled_truth -->
# Git 傳輸：isomorphic-git + GitHub REST + PAT

## 決定
筆記的 git 儲存層用 **isomorphic-git**（純 JS git 實作），搭配自寫的 **GitHub REST API transport**（走 `fetch`），認證用 **Personal Access Token**。不使用 SSH，不依賴原生 git 函式庫。

## 為什麼
- React Native 沒有 git。選項只有三種：(a) 編譯 libgit2 成原生模組，(b) 依賴裝置上的 git 二進位，(c) 純 JS。只有 (c) 能跨平台、能在 Expo/預建流程下工作、能用 Node 直接跑測試。
- GitHub REST API 沙盒限制少：contents/tree/blob/commit API 足以實作 pull/push，不需要走 git 智慧傳輸協定。isomorphic-git 官方提供的 `GitHubTransport` 即此路線。
- SSH 在 RN 需要 `ssh2` + crypto polyfill，行動端風險高且 token 過期/裝置管理更麻煩。
- PAT 讓「憑證在哪」變成一個單純的 app 設定，而不是主機環境問題。

## 約束
- **token 不進 git**。憑證存 OS keystore（`expo-secure-store`），不寫進 repo 設定檔、不進 commit、不進 log。
- 絕不記錄 token 到 console/logcat，錯誤訊息要過濾。
- 最小權限：repo 權限即可，不需要 admin。建議 fine-grained PAT 只給目標單一 repo。
- Git 層必須接受可注入的 transport，這樣測試能跑在假 transport 上，且未來要支援 Gitea/GitLab 只需換 transport 實作。

## 後果
- 大檔案（附件、圖片）走 LFS 不在第一階段範圍；先限制單檔大小並在 UI 提示。
- 首次 clone 走 GitHub API，全量歷史可能較慢；需做進度回報與可取消。


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
