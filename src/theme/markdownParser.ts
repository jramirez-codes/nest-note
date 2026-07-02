import { parseExpensiMark } from '@expensify/react-native-live-markdown';
import type { MarkdownRange } from '@expensify/react-native-live-markdown';

/**
 * Custom markdown parser for the notepad.
 *
 * ExpensiMark (the flavor bundled with `react-native-live-markdown`) treats a
 * single `*` as the bold delimiter, so a leading `* ` never becomes a bullet —
 * it just renders as a literal asterisk. This parser keeps all of ExpensiMark's
 * inline formatting (bold, italic, headings, code, quotes, links) and layers a
 * clean bullet-list system on top:
 *
 *   • `* item`, `- item`, `+ item`  → the whole line is inset from the margin
 *     (via the custom `listitem` block type — see the native patch in
 *     `patches/@expensify+react-native-live-markdown+*.patch`) so the list sits
 *     apart from body text, and the marker glyph is dimmed to the syntax color.
 *     Deeper levels are made by typing leading spaces, which step in on top of
 *     the list inset.
 *   • `* [ ] task`                  → an unchecked checkbox; the brackets dim.
 *   • `* [x] done`                  → a checked item: brackets dim and the label
 *     is struck through so finished tasks visibly recede.
 *
 * `listitem` is our own block type (blockquote is left untouched for real `>`
 * quotes). Markers inside fenced/indented code blocks are left alone.
 *
 * The whole function is a single self-contained worklet:
 * `react-native-live-markdown` runs the parser on the UI thread, so it (and the
 * `parseExpensiMark` call it composes with) must be workletized — hence the
 * `'worklet'` directive. Everything is inlined into one function so the UI
 * runtime never has to reach for another worklet or a passed-in closure.
 */

/** Markers accepted at the start of a line. `*` is the primary one; `-`/`+` are
 *  honored so muscle memory from other editors still yields a clean bullet. */
const BULLET_MARKERS = '*-+';

/** Range types that mark verbatim code, where a leading `*`/`-` is content, not
 *  a bullet, and must be left untouched. */
const CODE_TYPES = ['pre', 'code', 'codeblock'];

export function parseMarkdown(input: string): MarkdownRange[] {
  'worklet';

  // Start from ExpensiMark's ranges so every inline/block style keeps working.
  const ranges = parseExpensiMark(input);

  // Spans of verbatim code: any bullet-looking line overlapping one is skipped.
  const codeSpans: { start: number; end: number }[] = [];
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    if (CODE_TYPES.indexOf(r.type) !== -1) {
      codeSpans.push({ start: r.start, end: r.start + r.length });
    }
  }

  const len = input.length;
  let lineStart = 0;
  for (let i = 0; i <= len; i++) {
    if (i !== len && input[i] !== '\n') {
      continue;
    }
    const lineEnd = i; // exclusive; the '\n' (or EOF) is not part of the line.

    // Skip the line entirely if it falls inside a code span.
    let lineInCode = false;
    for (let s = 0; s < codeSpans.length; s++) {
      if (codeSpans[s].start < lineEnd && codeSpans[s].end > lineStart) {
        lineInCode = true;
        break;
      }
    }

    if (!lineInCode) {
      // Skip leading whitespace (indentation nests the bullet visually).
      let m = lineStart;
      while (m < lineEnd && (input[m] === ' ' || input[m] === '\t')) {
        m++;
      }

      // A bullet is a single marker char followed by a space, then optional
      // content. `*foo*` (no space) stays bold; `---` (no space) stays a rule.
      const isBullet =
        m < lineEnd &&
        BULLET_MARKERS.indexOf(input[m]) !== -1 &&
        m + 1 < lineEnd &&
        input[m + 1] === ' ';

      if (isBullet) {
        // Inset the whole line so the list sits apart from body text. `listitem`
        // is our custom block type; the native patch renders it as a left inset
        // with no bar (blockquote keeps its own bar for real `>` quotes).
        ranges.push({
          type: 'listitem',
          start: lineStart,
          length: lineEnd - lineStart,
          depth: 1,
        });

        // Dim the marker glyph itself; the following space stays as-is.
        ranges.push({ type: 'syntax', start: m, length: 1 });

        // Content begins after the marker's trailing spaces.
        let c = m + 1;
        while (c < lineEnd && input[c] === ' ') {
          c++;
        }

        // Checkbox: `[ ]`, `[x]` or `[X]` immediately followed by a space.
        const isCheckbox =
          c + 3 < lineEnd &&
          input[c] === '[' &&
          input[c + 2] === ']' &&
          input[c + 3] === ' ' &&
          (input[c + 1] === ' ' || input[c + 1] === 'x' || input[c + 1] === 'X');

        if (isCheckbox) {
          // Dim the `[ ]` / `[x]` marker.
          ranges.push({ type: 'syntax', start: c, length: 3 });

          // A checked box strikes through its label so done items recede.
          const checked = input[c + 1] === 'x' || input[c + 1] === 'X';
          if (checked) {
            let labelStart = c + 4;
            while (labelStart < lineEnd && input[labelStart] === ' ') {
              labelStart++;
            }
            if (labelStart < lineEnd) {
              ranges.push({
                type: 'strikethrough',
                start: labelStart,
                length: lineEnd - labelStart,
              });
            }
          }
        }
      }
    }

    lineStart = i + 1;
  }

  // The native renderer walks ranges in document order; keep them sorted by
  // start, longest-first on ties (mirrors the library's own ordering).
  ranges.sort((a, b) => a.start - b.start || b.length - a.length);
  return ranges;
}
