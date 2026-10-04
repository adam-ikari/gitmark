/**
 * Text edits as minimal splices.
 *
 * Every editing operation in this app is expressed as a replacement of a range
 * in the markdown source, never as a re-serialisation of the AST. That choice
 * is what keeps git history clean: if the user selects "hello" and presses bold,
 * only `**` is inserted around those six characters. Re-serialising the whole
 * document would normalise unrelated formatting and produce a diff on every
 * keystroke, which would make `git log` useless and turn sync into noise.
 */

export interface Splice {
  /** Inclusive start offset in the source. */
  start: number;
  /** Exclusive end offset in the source. */
  end: number;
  /** Replacement text. */
  text: string;
}

/** Apply a splice, returning the new source. */
export function applySplice(source: string, s: Splice): string {
  return source.slice(0, s.start) + s.text + source.slice(s.end);
}

/**
 * Translate an offset so it survives an edit at `splice`.
 *
 * Selections must move with the text they surround, otherwise a deletion above
 * the caret silently shifts what the user is about to overwrite.
 */
export function shiftOffset(offset: number, splice: Splice): number {
  const { start, end, text } = splice;
  if (offset <= start) return offset;
  if (offset >= end) return offset + text.length - (end - start);
  // Inside the replaced range: collapse to the end of the new text.
  return start + text.length;
}

/** A caret/selection pair in markdown source coordinates. */
export interface Selection {
  anchor: number;
  focus: number;
}

export function selectionRange(sel: Selection): [number, number] {
  return sel.anchor <= sel.focus ? [sel.anchor, sel.focus] : [sel.focus, sel.anchor];
}

export function isCollapsed(sel: Selection): boolean {
  return sel.anchor === sel.focus;
}

export function shiftSelection(sel: Selection, splice: Splice): Selection {
  return { anchor: shiftOffset(sel.anchor, splice), focus: shiftOffset(sel.focus, splice) };
}

/** Result of an editing operation: the new text plus where the caret goes. */
export interface EditResult {
  source: string;
  selection: Selection;
}

/**
 * Replace a range with `text` and put the caret after the inserted text.
 *
 * When the selection is collapsed this is a plain insertion, which is the case
 * for every keystroke.
 */
export function replaceRange(source: string, sel: Selection, text: string): EditResult {
  const [start, end] = selectionRange(sel);
  const caret = start + text.length;
  return {
    source: applySplice(source, { start, end, text }),
    selection: { anchor: caret, focus: caret },
  };
}

/** Insert at the caret, leaving any selection alone. */
export function insertAtCaret(source: string, sel: Selection, text: string): EditResult {
  return replaceRange(source, { anchor: sel.focus, focus: sel.focus }, text);
}

/** Delete the selection, or one character backwards if it is collapsed. */
export function deleteBackward(source: string, sel: Selection): EditResult {
  const [start, end] = selectionRange(sel);
  if (start !== end) {
    return { source: applySplice(source, { start, end, text: '' }), selection: { anchor: start, focus: start } };
  }
  if (start === 0) return { source, selection: sel };
  return {
    source: applySplice(source, { start: start - 1, end: start, text: '' }),
    selection: { anchor: start - 1, focus: start - 1 },
  };
}

export function deleteForward(source: string, sel: Selection): EditResult {
  const [start, end] = selectionRange(sel);
  if (start !== end) {
    return { source: applySplice(source, { start, end, text: '' }), selection: { anchor: start, focus: start } };
  }
  if (start >= source.length) return { source, selection: sel };
  return {
    source: applySplice(source, { start, end: start + 1, text: '' }),
    selection: { anchor: start, focus: start },
  };
}