---
id: native-richtext-editor
title: "原生富文本編輯器"
category: decision
status: active
tags: [不使用 WebView 編輯]
created: "2026-10-04T13:39:43"
updated: "2026-10-05T01:18:11"
---

<!-- compiled_truth -->
# 原生編輯器：區塊 WYSIWYG + 行內語法高亮

## 決定（2026-10-05 修訂，取代先前的「分層疊加」方案）
編輯器**完全原生**實作，採用**每個區塊一個 `TextInput`** 的結構：區塊類型（標題、清單項目、引用、程式碼）以真實樣式渲染在輸入框**之外**，行內的 markdown 標記（`**`、`*`、`~~`、`` ` ``）在輸入框內以淡化樣式顯示。

**先前的「底層樣式 `<Text>` + 上層透明 `TextInput`」方案已證實不可行**，見下。

## 為什麼不可行（實測結論，不可重蹈）
該方案要求上層 `TextInput` 與底層 `<Text>` **渲染完全相同的字元流**，才能在軟換行時於同一欄斷行。三項實測結果：

1. **Android 的 `TextInput` 不接受 styled children。** `attributedText` 只出現在 iOS 的 `.mm` 實作（`RCTBaseTextInputView.mm`、`RCTUITextView.mm` 等），`ReactAndroid` 中零出現。styled children 是 `UITextView.attributedText` 的能力。
2. **隱藏標記不會移除它的 advance width。** `opacity: 0` 的 span 仍佔滿寬度，因此底層少了 `**` 就不可能與上層對齊。
3. **`letterSpacing` 雖可把 span 壓到 0 寬度（`letterSpacing = -charWidth`），但上層無 per-range styling 可套用同樣的壓縮**，兩層仍不一致。

結論：只要底層顯示的內容與 markdown 原文**不是同一串字元**，對齊就不可能。這不是字型度量的細節問題，是架構層級矛盾。任何「先渲染成富文本、再用透明輸入框蓋上去」的思路在 Android 上都會失敗。

## 為什麼選這個替代方案
- 上層輸入框與樣式層**字元流相同**（都是 markdown 原文），因此可以在同一欄斷行、**可靠對齊**。
- 區塊結構（字級、清單符號、引用線）在輸入框外以真實樣式呈現，達成區塊級 WYSIWYG。
- 行內標記以淡化樣式顯示，視覺噪音低，接近 Typora/Obsidian 的 source mode 體驗。
- 完全原生，中文輸入法（IME 組字）與軟換行安全。已對照 `react-native@0.86.3` 原始碼驗證，非憑記憶。

## 約束
- **markdown 是唯一真實來源**，每個 `TextInput` 的 `value` 就是該區塊的 markdown 原文。
- 樣式層與輸入層**必須由同一個 style 物件產生**（見 `app/theme/tokens.ts` 的 `body`，其 `lineHeight` 明確指定而非依賴平台預設）。平台預設會因字型 fallback 而異，必然導致錯位。
- 每個區塊一個 `TextInput` 會有元件數量與效能成本；大筆記需要虛擬化，這是已知後續工作。
- 行內標記不可見的「真 WYSIWYG」在 Android 上不交付。若要它，只能放棄本約束（見 [[native-richtext-editor]] 的 timeline）。

## 相關
[[surgical-splices]] — 編輯操作仍是最小 splice；元件只負責把手勢轉成 core 的純函式呼叫，不含任何 markdown 邏輯。


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

- time: 2026-10-05T01:17:55
  kind: decision
  summary: "Two-layer overlay is impossible on Android; using one TextInput per block with inline syntax highlighting"
  source: verified against react-native 0.86.3 source 2026-10-05
  affects: [native-richtext-editor]

- time: 2026-10-05T01:18:11
  kind: reversal
  summary: "Reversed the two-layer overlay design: it cannot align, because hidden markdown markers keep their advance width and Android TextInput has no per-range styling"
  source: verified against react-native 0.86.3 source 2026-10-05
  affects: [native-richtext-editor]
