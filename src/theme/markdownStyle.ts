import type { MarkdownStyle } from '@expensify/react-native-live-markdown';
import type { ThemeColors } from './colors';

/**
 * Build the style object consumed by `MarkdownTextInput`, driven by the active
 * theme so inline markdown rendering matches the rest of the UI in light/dark.
 */
export function createMarkdownStyle(colors: ThemeColors): MarkdownStyle {
  return {
    syntax: {
      color: colors.syntax,
    },
    link: {
      color: colors.accent,
    },
    h1: {
      fontSize: 24,
    },
    blockquote: {
      borderColor: colors.accent,
      borderWidth: 4,
      marginLeft: 4,
      paddingLeft: 12,
    },
    code: {
      fontFamily: 'Courier',
      fontSize: 15,
      color: colors.text,
      backgroundColor: colors.codeBackground,
    },
    pre: {
      fontFamily: 'Courier',
      fontSize: 15,
      color: colors.text,
      backgroundColor: colors.codeBackground,
    },
  };
}
