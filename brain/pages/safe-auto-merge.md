---
id: safe-auto-merge
title: "安全自動合併"
category: decision
status: active
tags: [diff3 三方合併, 真衝突才提示]
created: "2026-10-04T13:39:43"
updated: "2026-10-04T16:21:53"
---

<!-- compiled_truth -->
# 衝突處理：安全自動合併，真衝突才提示

## 決定
同步衝突一律走 **diff3 三方合併**：base / local / remote。改動區間不重疊就自動合併（靜默、不打擾使用者）；重疊且無法自動化解才升級為「真衝突」，寫出可辨識的衝突標記並在 UI 列出讓人來選。**永不靜默丟資料、永不 last-writer-wins 覆蓋。**

## 為什麼
筆記是純文字、行數通常不長。diff3 在文字上的成功率高，且失敗時是可讀的三段式標記而非資料損毀。相比之下 last-writer-wins 會無聲吃掉一個人的整篇修改——對筆記這種個人資料而言這是最糟的失敗模式。

## 約束
- 三方合併必須有明確的 **base**：每次同步前把遠端 HEAD 與本機「上次同步的 HEAD」一起視為 base，不能假設任意祖先。
- 自動合併後**不得**直接覆蓋本機檔案；先寫入並標記狀態，讓 UI 有機會顯示「已自動合併」。
- 真衝突的處理必須是**三選一或手動編輯**，不做二選一（沒有「丟掉我的修改」這種預設按鈕）。
- 合併演算法本身要能在純 Node 裡測試，不依賴 RN 或 git 函式庫。

## 後果
- 需要維護自己的 diff3 實作（或移植一個），這是 core 層最需要測試覆蓋的模組。
- 同步流程必須是明確的狀態機：`idle → fetching → three-way-merge → (clean | conflicted) → pushing`，衝突時停在 conflicted 等人處理，不能自動 push。


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
