/**
 * The font style for one block.
 *
 * Extracted from the component so the alignment invariants can be tested
 * without a renderer, and so there is exactly one place where a block's type is
 * turned into typography. Two layers agreeing depends on both being handed the
 * result of this function, never two separately written style objects.
 */

import type { TextStyle } from 'react-native';

import { heading as headingStyle, body, mono } from '../theme/tokens.ts';

/**
 * Only the parts of a block the style depends on.
 *
 * Accepts every block type, not just the editable ones: read-only blocks render
 * through this same function so a code block looks identical whether it is being
 * edited or displayed.
 */
export type BlockKind =
  | { type: 'paragraph' }
  | { type: 'heading'; depth: 1 | 2 | 3 | 4 | 5 | 6 }
  | { type: 'code'; lang?: string | null }
  | { type: 'mermaid' }
  | { type: 'svg' }
  | { type: 'quote' }
  | { type: 'list' }
  | { type: 'hr' }
  | { type: 'table' };

export function blockTextStyle(block: BlockKind): TextStyle {
  if (block.type === 'heading') return headingStyle(block.depth);
  if (block.type === 'code' || block.type === 'mermaid' || block.type === 'svg') {
    return { ...body, fontFamily: mono, fontSize: 14, lineHeight: 20 };
  }
  return body;
}