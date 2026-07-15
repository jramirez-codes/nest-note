import React, { useCallback } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import type { Note } from '../../types/note';
import NoteEditorWebView from './NoteEditorWebView';

interface NotePageProps {
  note: Note;
  /** Exact page width so the sheet fills its slot in the pager. */
  width: number;
  /** Whether this page is the one currently on top in the pager. Drives blur so
   *  the caret/keyboard doesn't stay on a page you've swiped away from. */
  isActive: boolean;
  onChangeContent: (id: string, content: string) => void;
  onSetTitle: (id: string, title: string) => void;
  /** Called after `/ingest` files this page into the dashboard — deletes the page. */
  onIngested: (id: string) => void;
  /** Called after `/archive` lifts this page off the pad into the Archived section. */
  onArchived?: (id: string) => void;
  /** A tapped wikilink asks to flip the pad to `title` (in notebook `slug`, or the current one). */
  onOpenPage?: (slug: string, title: string) => void;
  /** An AI card's full-page overlay opened/closed — see NoteEditorWebView. */
  onWidgetExpandChange?: (expanded: boolean) => void;
  /** Notebook this page lives in — /record clips are bucketed by notebook + page id. */
  notebookId: string;
  /** Render the page read-only (no caret, no edits) — used for server-owned pages
   *  like an idea card opened from the dashboard, which Claude authors. */
  readOnly?: boolean;
}

/**
 * A single page of the pad: just the markdown editor. The page header (number,
 * date, delete) lives in the screen chrome so it stays put while pages turn.
 *
 * Memoized so that editing one page (which updates the parent's notes array)
 * does not re-render its sibling pages.
 */
function NotePage({
  note,
  width,
  isActive,
  onChangeContent,
  onSetTitle,
  onIngested,
  onArchived,
  onOpenPage,
  onWidgetExpandChange,
  notebookId,
  readOnly = false,
}: NotePageProps) {
  const handleChangeContent = useCallback(
    (content: string) => onChangeContent(note.id, content),
    [note.id, onChangeContent],
  );
  const handleSetTitle = useCallback(
    (title: string) => onSetTitle(note.id, title),
    [note.id, onSetTitle],
  );
  const handleIngested = useCallback(
    () => onIngested(note.id),
    [note.id, onIngested],
  );
  const handleArchived = useCallback(
    () => onArchived?.(note.id),
    [note.id, onArchived],
  );

  return (
    <View style={{ width }} className="flex-1 bg-background">
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <NoteEditorWebView
          initialContent={note.content}
          isActive={isActive}
          hasTitle={note.title.trim().length > 0}
          onChangeContent={handleChangeContent}
          onSetTitle={handleSetTitle}
          onIngested={handleIngested}
          onArchived={handleArchived}
          onOpenPage={onOpenPage}
          onWidgetExpandChange={onWidgetExpandChange}
          notebookId={notebookId}
          pageId={note.id}
          readOnly={readOnly}
        />
      </KeyboardAvoidingView>
    </View>
  );
}

export default React.memo(NotePage);
