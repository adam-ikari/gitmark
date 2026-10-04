/**
 * Markdown AST — the shared intermediate representation.
 *
 * Layering rule (see brain/architecture.md): the *persisted* artifact is always
 * markdown text. The AST is derived from it, never stored. Every view (editor,
 * renderer) consumes this same shape, so they can never disagree.
 */

export type Inline =
  | { type: 'text'; value: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'strike'; children: Inline[] }
  /** Inline code. Content is literal — never parsed for nested markup. */
  | { type: 'code'; value: string }
  | { type: 'link'; href: string; title: string | null; children: Inline[] }
  | { type: 'image'; src: string; alt: string; title: string | null }
  /** Two trailing spaces or a backslash before a newline. */
  | { type: 'hardbreak' }
  /** A bare newline inside a paragraph. */
  | { type: 'softbreak' };

export type Align = 'left' | 'center' | 'right' | null;

export type Block =
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'heading'; depth: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { type: 'code'; lang: string | null; value: string }
  /** A fenced block whose language routes to a dedicated renderer. */
  | { type: 'mermaid'; value: string }
  | { type: 'svg'; value: string }
  | { type: 'quote'; children: Block[] }
  | { type: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { type: 'hr' }
  | {
      type: 'table';
      align: Align[];
      header: Inline[][];
      rows: Inline[][][];
    };

export interface ListItem {
  /** false for a GFM task-list item whose box is ticked. */
  checked: boolean | null;
  children: Block[];
}

// ---------------------------------------------------------------------------
// Inline spans carry their own source range.
//
// The editor needs to map a caret position in markdown source coordinates onto
// a parsed node. Without ranges that mapping is guesswork.
// ---------------------------------------------------------------------------

export type Ranged<T> = T & { start: number; end: number };

export type RangedInline = Ranged<Inline>;
export type RangedBlock = Ranged<Block>;

export type Document = Block[];