import React from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, View } from 'react-native';
import NoteEditorWebView from './NoteEditorWebView';
import { useTheme } from '../../theme/colors';

const noop = () => {};

interface VirtualNotePageProps {
  /** The page's markdown body, or undefined while it's still being fetched. */
  body: string | undefined;
  /** Exact page width so the sheet fills its slot in the pager. */
  width: number;
  /** Whether this page is the one currently on top in the pager. */
  isActive: boolean;
  /** A tapped wikilink asks to flip the pad to `title` (in notebook `slug`, or the current one). */
  onOpenPage?: (slug: string, title: string) => void;
  /** An AI card's full-page overlay opened/closed — see NoteEditorWebView. */
  onWidgetExpandChange?: (expanded: boolean) => void;
  /** Subject slug + page id this virtual page belongs to (passed through for media bucketing;
   *  these pages are read-only so recording never actually fires here). */
  notebookId: string;
  pageId: string;
}

/**
 * A single page of a swapped-to subject notebook: the same markdown editor the local pad
 * uses, but fed by content pulled from the server rather than local storage. While the
 * body is still loading it shows a spinner; the editor mounts (with the body as its initial
 * content) only once the page is in hand, which is usually before the reader swipes to it
 * thanks to the neighbour prefetch in useNotebookPages.
 *
 * The editor is mounted read-only (no caret, no typing) since these pages are server-owned
 * and viewed, not edited, on the phone — only the local Sandbox is editable. Keyed per page
 * by the pager, so each page mounts with the right content.
 */
function VirtualNotePage({
  body,
  width,
  isActive,
  onOpenPage,
  onWidgetExpandChange,
  notebookId,
  pageId,
}: VirtualNotePageProps) {
  const colors = useTheme();
  return (
    <View style={{ width }} className="flex-1 bg-background">
      {body === undefined ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color={colors.muted} />
        </View>
      ) : (
        <KeyboardAvoidingView
          className="flex-1"
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <NoteEditorWebView
            initialContent={body}
            isActive={isActive}
            hasTitle
            readOnly
            onChangeContent={noop}
            onSetTitle={noop}
            onIngested={noop}
            onOpenPage={onOpenPage}
            onWidgetExpandChange={onWidgetExpandChange}
            notebookId={notebookId}
            pageId={pageId}
          />
        </KeyboardAvoidingView>
      )}
    </View>
  );
}

export default React.memo(VirtualNotePage);
