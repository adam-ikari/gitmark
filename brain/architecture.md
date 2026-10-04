---
slug: architecture
title: System architecture
role: system architecture
updated: "2026-10-04T13:47:22"
---

# System architecture

---
slug: architecture
title: Architecture
role: system structure
---

## 一句話
markdown 是唯一真實來源；git 是儲存層與同步層；編輯器與渲染器都是 markdown 的**視圖**。

## 分層

```
core/            純 TypeScript，無 RN、無 IO。可用 node --test 直接測。
  markdown/      markdown <-> AST（inline spans + block tree）
  richtext/      文件模型 + 編輯操作（toggleMark / splitBlock / indent…）
  merge/         diff3 三方合併（base / local / remote）
  git/           git 語意封裝，transport 與 fs 皆注入
app/             React Native / Expo
  screens/       筆記列表、編輯器、渲染預覽、同步狀態、衝突處理
  components/    RichTextEditor、MarkdownView、MermaidView、SvgView
  native/        平台膠水（secure-store、fs）
```

## 資料流

**編輯**：使用者操作 → `richtext` 操作（純函式）→ 更新 AST → 序列化為 markdown → 存檔 → git commit。

**同步**：fetch remote HEAD → 以「上次同步的 HEAD」為 base 做 diff3 → 不重疊則自動合併 → 重疊則標記 conflicted 並停在 UI 等人處理 → 否則 commit + push。

## 不可違反的規則

1. **不存在雙向轉換。** 沒有「富文本格式 <-> markdown」的雙向轉換層；AST 是唯一的中間表示，編輯與渲染都走它。任何時候都能從 markdown 重建完整狀態。
2. **core 不 import app。** 反向依賴會讓測試需要 RN 環境，直接摧毀可測試性。
3. **合併不丟資料。** 自動合併只在改動不重疊時發生；重疊必須升級為真衝突交人處理（[[safe-auto-merge]]）。
4. **token 不落盤到明文。** 只在 keystore，且不進 log（[[github-pat-git-transport]]）。
5. **同步是狀態機。** 衝突時必須停在 `conflicted`，不得自動 push。

## 三層視圖共享同一份 AST

```
markdown text
     │  parse / serialize
     ▼
   AST  ◄────────── richtext 操作（編輯時）
     │
     ├──► MarkdownView  （原生元件：標題/清單/程式碼/表格/圖片）
     ├──► SvgView       （react-native-svg）
     └──► MermaidView   （WebView 沙盒）
```

AST 只解析一次，渲染層各自消費。編輯與預覽因此永遠一致——這是自寫解析器而非用現成套件的主要理由。

## 為什麼不是「編輯 markdown 原始碼」
純文字編輯器無法提供行內富文本（[[native-richtext-editor]]）。但保留 markdown 作為真實來源又帶來可攜性：筆記脫離這個 app 仍是可讀的純文字，且能用任何其他工具編輯。這是刻意的取捨。
