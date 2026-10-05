---
id: safe-auto-merge
title: "安全自動合併"
category: decision
status: active
tags: [diff3 三方合併, 真衝突才提示]
created: "2026-10-04T13:39:43"
updated: "2026-10-05T05:45:29"
---

<!-- compiled_truth -->
# 衝突處理：安全自動合併，真衝突才提示

## 決定
同步衝突一律走 **diff3 三方合併**：base / local / remote。改動區間不重疊就自動合併（靜默、不打擾使用者）；重疊且無法自動化解才升級為「真衝突」，寫出可辨識的衝突標記並在 UI 列出讓人來選。**永不靜默丟資料、永不 last-writer-wins 覆蓋。**

## 解決的單位是「衝突區域」，不是「檔案」
一個有三處衝突的筆記不會得到一個「保留我的」按鈕。**逐檔選擇等同於接受對方的兩處修改而拒絕第三處（或反之），而且無法表達是哪兩處。** 所以每個區域獨立選擇。

每個區域三選一：**我的版本 / 對方的版本 / 手動編輯**。沒有預選項，沒有「丟掉我的修改」這種預設按鈕。

## 關鍵約束：區域索引是「位置」，不是「身分」
解決一個區域會刪掉它的標記，**後面所有區域的索引全部位移**。因此：

- 解決流程持有的是**載入時的文本快照**，選擇記錄在快照上的索引，**最後一次套用**。
- **絕不能**每按一次就重寫筆記並重新推導索引——那會把剩下��選擇滑到錯誤的文本上。
- `resolvedText` 在還有未決定區域時回傳 `null`，而不是部分結果。commit 路徑因此「沒有東西可寫」，而不是「寫進一份還帶標記的筆記」。

這條是實作時最容易犯的錯，所以測試直接釘住「位移」這個現象本身。

## 未關閉的衝突區域不能靠選擇解決
`<<<<<<<` 之後沒有 `=======` 或沒有 `>>>>>>>`，代表**對方那一側從未被界定**——按「用對方的」等於猜測。這種區域只提供「手動編輯」。

這用**顯式的 `closed` 旗標**表達，不是用「remote 為空」推斷：空的一側是合法的（有人刪掉整段 = 真衝突）。

## 約束
- 三方合併必須有明確的 **base**：每次同步前把遠端 HEAD 與本機「上次同步的 HEAD」一起視為 base，不能假設任意祖先。
- 自動合併後**不得**直接覆蓋本機檔案；先寫入並標記狀態，讓 UI 有機會顯示「已自動合併」。
- 真衝突的處理必須是**三選一或手動編輯**，不做二選一（沒有「丟掉我的修改」這種預設按鈕）。
- 合併演算法本身要能在純 Node 裡測試，不依賴 RN 或 git 函式庫。
- **commit 前的最後一道防線是 `assertResolved(text)`**，接受「即將寫入的文本」而非「選擇集合」——檢查位元組本身，不是本模組的簿記。帶標記的筆記進到共享 repo，下一台拉取的裝置就會繼承那些標記。
- 寫入 API 的 `guard` **預設關閉**：寫入帶標記的文本正���是標記進入檔案的方式，所以不能無條件擋。

## 後果
- 需要維護自己的 diff3 實作（或移植一個），這是 core 層最需要測試覆蓋的模組。
- 同步流程必須是明確的狀態機：`idle → fetching → three-way-merge → (clean | conflicted) → pushing`，衝突時停在 conflicted 等人處理，不能自動 push。
- 筆記列表必須把**整個 item**（含 `conflicted` 旗標）交給開啟處理器：有衝突的筆記進解決畫面，乾淨的進編輯器。只給路徑的話，呼叫端無從判斷。
- 解決後的筆記只是本機變更，仍需下一次同步才會推上去；UI 不應暗示已發布。


## Timeline

- time: 2026-10-04T13:39:43
  kind: decision
  summary: "Created this page: 安全自動合併"
  source: user-confirmed 2026-10-04
  affects: [safe-auto-merge]

- time: 2026-10-04T13:40:21
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: user-confirmed 2026-10-04
  affects: [safe-auto-merge]

- time: 2026-10-04T16:21:53
  kind: decision
  summary: Settled two merge policies and the real no-data-loss invariant while implementing diff3
  source: merge3 implementation 2026-10-04
  affects: [safe-auto-merge]

- time: 2026-10-05T05:45:29
  kind: decision
  summary: "Settled conflict resolution: per-region rather than per-file, decisions applied once against a snapshot because region indices renumber"
  source: "實作 ConflictScreen 2026-10-05"
  affects: [safe-auto-merge]

- time: 2026-10-05T05:45:29
  kind: decision
  summary: "Resolved the 三選一 requirement: per-region choices applied in one pass against a snapshot, plus the commit-time assertResolved gate"
  source: "core/merge/resolve.ts, app/screens/ConflictScreen.tsx 2026-10-05"
  affects: [safe-auto-merge]
