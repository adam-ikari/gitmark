/**
 * The settings the two-layer editor's correctness rests on.
 *
 * These are declarations rather than behaviour, and they exist as an object so a
 * test can assert them. The failure they guard against is subtle and only shows
 * up on a real device: if the styled layer stops sharing the input's style, or
 * starts hiding characters, or the two layers disagree about font scaling, the
 * editor still runs and still saves correct markdown — it just puts the caret in
 * the wrong place when you tap. That is a bug nobody would think to look for.
 */

export interface EditorLayerConfig {
  /** The input and the highlight layer are given the same style object. */
  sharedStyle: boolean;
  /** The highlight layer renders every character, including markdown markers. */
  highlightHidesCharacters: boolean;
  /** The input draws no glyphs of its own. */
  inputDrawsGlyphs: boolean;
  /** Both layers honour the system font size. */
  allowFontScaling: boolean;
}

export function blockEditorConfig(): EditorLayerConfig {
  return {
    sharedStyle: true,
    highlightHidesCharacters: false,
    inputDrawsGlyphs: false,
    allowFontScaling: true,
  };
}