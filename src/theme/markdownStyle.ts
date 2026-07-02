import { Platform } from 'react-native';
import type { MarkdownStyle } from '@expensify/react-native-live-markdown';
import type { ThemeColors } from './colors';

/** Obsidian renders code in a mono face; use the platform's default mono. */
const MONO_FONT = Platform.select({ ios: 'Menlo', default: 'monospace' });

/**
 * Style object for `MarkdownTextInput`, tuned to read like Obsidian's default
 * editor: formatting marks (`#`, `*`, backticks) are dimmed, headings are large,
 * quotes get a muted left bar, and code sits on a rounded subtle surface. Bold
 * and italic weights are applied automatically by the parser. Colors come from
 * the active Catppuccin theme so it matches the rest of the UI.
 */
export function createMarkdownStyle(colors: ThemeColors): MarkdownStyle {
  return {
    syntax: {
      // The markdown control characters, de-emphasized as in Obsidian.
      color: colors.syntax,
    },
    link: {
      color: colors.accent,
    },
    h1: {
      // Obsidian's default H1 is ~1.8× body size.
      fontSize: 30,
    },
    blockquote: {
      borderColor: colors.muted,
      borderWidth: 4,
      marginLeft: 2,
      paddingLeft: 14,
    },
    code: {
      fontFamily: MONO_FONT,
      fontSize: 15,
      color: colors.text,
      backgroundColor: colors.codeBackground,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 4,
      paddingHorizontal: 4,
    },
    pre: {
      fontFamily: MONO_FONT,
      fontSize: 15,
      color: colors.text,
      backgroundColor: colors.codeBackground,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 8,
      padding: 12,
    },
  };
}
