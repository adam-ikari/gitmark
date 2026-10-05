/**
 * The app's user-facing text is Simplified Chinese.
 *
 * This is a guard, not a restatement. The strings are scattered across fifteen
 * files, they were all Traditional for months, and nothing in the type system or
 * the test suite noticed when half of them were converted. A scanner is the only
 * thing that notices the next one.
 *
 * ## Where the list comes from, and why it is not hand-written
 *
 * The list is the set of characters OpenCC changes when converting a large
 * Traditional corpus — the brain pages, plus every Chinese string literal that
 * shipped — to Simplified. That gives 232 characters that are Traditional-only in
 * practice, and, more usefully, leaves out characters that merely *look*
 * Traditional. An earlier hand-written list included 突, which is identical in
 * both scripts, so it flagged the correct text 冲突 as a violation. A guard that
 * cries wolf on correct text gets deleted.
 *
 * The characters shared by both scripts are simply absent, which is why no CJK
 * coverage assertion appears here: 說 becoming 说 is caught, and the hundreds of
 * identical characters cannot be.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;

/** Traditional-only forms, derived from a corpus rather than chosen by hand. */
const TRADITIONAL_ONLY =
  '丟並乾佔併來倉個們側備傳儲內兩別刪則剝動務勢區協卻問啟單圍圖報塊壓夾實寫寬將專對導層屬帶幾庫後徑從態憑憶應懸捨採換損擇擊擋擔擬擾攜敗數斷於時會東條棄構標樣機檔檢欄權歸毀決沒淨測滿濾為無狀獨現環產畫異當疊發盤確碼礙種稱筆節範簽約純級細組結絕給統經綠維網線編縮繞繼續脫膠與蓋處虛號衝補裝裡見規視覺覽訂計訊記設許試話該認誘語誤請論謂謎證識譯護讀變讓負責費資質賴軟載輯輸轉這連進運過達違遠適選遺還邊邏釘鈕錄錯鍵鏈鑰長閉開間關陣階際隨隱雖雙雜離靜響項順須預頭題類顯驗體麼點齊';

/** Strip comments, so prose about the check is not itself checked. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every non-test source file, which is where user-facing strings live. */
function appSources(dir = ROOT, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      appSources(full, found);
      continue;
    }
    if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

test('no source file contains Traditional-only forms in its code', () => {
  const offenders: string[] = [];
  for (const file of appSources()) {
    const hits = [...TRADITIONAL_ONLY].filter((char) => codeOf(file).includes(char));
    if (hits.length > 0) offenders.push(`${file.slice(ROOT.length)}: ${hits.join('')}`);
  }
  assert.deepEqual(offenders, [], 'app copy must be Simplified Chinese');
});

test('the checker does not fire on Simplified text', () => {
  // A guard that flags correct text gets deleted rather than fixed, so this is
  // the assertion that keeps it worth having.
  const sample = '笔记合并冲突，请选择我的版本，对方的版本，手动编辑。保存并连接。读取设置…退出登录';
  assert.deepEqual([...TRADITIONAL_ONLY].filter((char) => sample.includes(char)), []);
});

test('the checker does fire on Traditional text', () => {
  const sample = '筆記合併衝突，請選擇我的版本';
  assert.ok([...TRADITIONAL_ONLY].some((char) => sample.includes(char)));
});

test('the list is free of characters shared by both scripts', () => {
  // 突 is the one that actually bit: 冲突 is correct Simplified, and a list
  // containing it would have failed on correct text from the first run.
  for (const char of ['突', '的', '我', '你', '是', '不']) {
    assert.equal(TRADITIONAL_ONLY.includes(char), false, `${char} is shared by both scripts`);
  }
});

test('the list has no repeated characters', () => {
  assert.equal(new Set(TRADITIONAL_ONLY).size, TRADITIONAL_ONLY.length);
});