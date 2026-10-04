---
id: native-richtext-editor
title: "原生富文本編輯器"
category: decision
status: active
tags: [不使用 WebView 編輯]
created: "2026-10-04T13:39:43"
updated: "2026-10-04T13:40:21"
---

<!-- compiled_truth -->
# 編輯器：原生富文本，不用 WebView

## 決定
編輯器**完全原生**實作（React Native 元件），不走 WebView + CodeMirror/ProseMirror 路線。使用者明確選擇「原生實現完整富文本編輯」。

## 為什麼
使用者要求的是真正的行內富文本體驗，並且不接受把編輯狀態放在 WebView 裡。純 RN 方案在鍵盤行為、手勢、與 RN 元件的整合上最可預測。

## 關鍵技術前提（重要）
React Native 的 `TextInput` 在 **Android 上不接受富文本 children**（styled `<Text>` 子節點）——那是 iOS `UITextView.attributedText` 才有的能力。所以 Android 的行內富文本不能靠「塞 styled children」達成。

因此採用**分層疊加方案**：
- 底層：`<Text>` 渲染解析後的 inline span（粗體/斜體/行內程式碼/連結的實際視覺樣式）。
- 上層：透明文字的 `<TextInput>` 擷取輸入與選取，字型/行高/邊界與底層**逐項對齊**。
- 使用者看到的是行內富文本，實際儲存的仍是 markdown 原文，編輯時存的是 markdown。

## 約束
- **markdown 是唯一真實來源（single source of truth）**。不存在「富文本文件格式」與「markdown」之間的雙向轉換；編輯器只是 markdown 的一個視圖。任何時候都能從 markdown 重建整個編輯狀態。
- 字型度量對齊是本方案的主要脆弱點：底層與上層的 `fontFamily` / `fontSize` / `lineHeight` / padding / 水平邊界必須由**同一個 style 物件**產生，不可在兩處各寫一份。
- 選取區間（selection）要能在 markdown 原文座標與解析後 span 座標之間轉換。
- mermaid 渲染仍需 WebView（mermaid.js 需要 DOM，行動端無替代）。這與「編輯不用 WebView」不衝突：編輯是原生的，mermaid 是沙盒化的唯讀渲染。

## 後果
- 程式碼量最大的模組。應獨立成一個可測試的「文件模型 + 編輯操作」純 TS 層，元件只負責渲染與手勢。
- 逐行折行（soft wrap）必須與底層完全一致，否則點擊位置會偏移；需要在實機上用密集文字與中英文混排驗證。


## Timeline

- time: 2026-10-04T13:39:43
  kind: decision
  summary: "Created this page: 原生富文本編輯器"
  source: user-confirmed 2026-10-04
  affects: [native-richtext-editor]

- time: 2026-10-04T13:40:21
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: user-confirmed 2026-10-04
  affects: [native-richtext-editor]
