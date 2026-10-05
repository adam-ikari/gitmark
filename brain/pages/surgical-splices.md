---
id: surgical-splices
title: "編輯必須是對 markdown 原文的最小 splice"
category: decision
status: active
tags: [richtext, git, splice]
created: "2026-10-05T00:34:50"
updated: "2026-10-05T00:35:14"
---

<!-- compiled_truth -->
# 編輯必須是對 markdown 原文的最小 splice

## 決定
所有編輯操作（行內標記、Enter、Backspace、清單、標題、任務）都表達成**對 markdown 原文某個範圍的替換**，永遠不是「把 AST 重新序列化一次」。

## 為什麼
AST 只在需要**解讀**時產生（判斷選取範圍是否已被加粗、判斷 Enter 該不該延續清單）。一旦拿 AST 當成寫回的格式，序列化器就會「順便正規化」無關的東西：

- 選取 `italic` 按粗體，本該只插入 `**`
- 但重新序列化會把 `###   Title` 變成 `### Title`、把 `-   item` 變成 `- item`

結果是**每次按鍵都在 git 產生一個 diff**。`git log` 會被雜訊淹沒，同步時每個檔案看起來都被改過，三方合併也會到處誤判衝突。這對一個「以 git 為儲存層」的 app 是致命的。

## 實作期間確立的三條規則

1. **移除一個構造的兩端時，先刪結尾。** 先刪開頭會使結尾的偏移失效，留下 `hello **world` 這種懸空標記。
2. **正則的分組索引是脆弱的。** `BULLET` 與 `ORDERED` 的分組數不同、`LIST_RE` 只有 4 組卻被寫成 `$5`，兩次都造成**靜默損毀**：文件裡出現字面的 `$5`，或每個清單項目的內容變成空字串。凡是會用到分組的 regex，都要有斷言「輸出文字」的測試。
3. **判斷選取範圍的標記要用「包含」而非「相等」。** `***both***` 解析成 em[strong]，選取 `both` 同時是粗體和斜體；用相等判斷會回報「非斜體」，於是每按一次再多包一層星號。

## 約束
- 每一個編輯函式的回傳型別都是 `EditResult { source, selection }`，其中 `source` 是完整新文字、`selection` 是新的 caret 位置。中間不可經過 AST。
- caret 位置必須跟著文字移動（`shiftOffset`）。刪掉 caret 上方的文字若不移動 caret，使用者下一次輸入就會蓋掉錯的字。
- caret 偏移必須 clamp 到 `[0, length]`。React Native 會**默默**把超出範圍的選取拉回來，導致我們的 caret 與平台實際位置不一致（見 [[native-richtext-editor]] 的度量對齊要求）。
- 回歸測試要驗「最小性」：編輯前後逐行比對，除了被編輯的那一行，其他每一行必須 byte-identical。

## 後果
- 序列化器**不存在**，也不需要。這是刻意的：它沒有需求，且它的存在本身就是一個會產生無謂 diff 的誘因。
- AST 的 source range 是必需品而非選配。沒有 range 就無法把 caret 映射到節點，而 range 的欄位名是 `srcStart`/`srcEnd`（`start`/`end` 會和 `list.start` 這類語意欄位撞名）。
- 解析器允許「格式不完美」的文件存在並原樣保留，使用者不該因為打了一個字就被改寫整份文件。

## 相關
[[native-richtext-editor]] — 編輯器元件只負責把手勢事件轉成這些純函式呼叫；元件裡不應有任何 markdown 邏輯。


## Timeline

- time: 2026-10-05T00:34:50
  kind: decision
  summary: "Created this page: 編輯必須是對 markdown 原文的最小 splice"
  source: core/richtext implementation 2026-10-05
  affects: [surgical-splices]

- time: 2026-10-05T00:35:14
  kind: decision
  summary: "Editing is minimal markdown splices over source; no serializer exists by design"
  source: core/richtext implementation 2026-10-05
  affects: [surgical-splices]

- time: 2026-10-05T00:35:14
  kind: decision
  summary: "Three rules established during implementation: delete the closer first, regex group indices are fragile, mark detection uses containment not equality"
  source: core/richtext implementation 2026-10-05
  affects: [surgical-splices]
