import React, { useCallback } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import type { Note } from '../types/note';
import NoteEditor from './NoteEditor';

interface NotePageProps {
  note: Note;
  /** Exact page width so the sheet fills its slot in the pager. */
  width: number;
  onChangeContent: (id: string, content: string) => void;
}

/**
 * A single page of the pad: just the markdown editor. The page header (number,
 * date, delete) lives in the screen chrome so it stays put while pages turn.
 *
 * Memoized so that editing one page (which updates the parent's notes array)
 * does not re-render its sibling pages.
 */
function NotePage({ note, width, onChangeContent }: NotePageProps) {
  const handleChangeContent = useCallback(
    (content: string) => onChangeContent(note.id, content),
    [note.id, onChangeContent],
  );

  return (
    <View style={{ width }} className="flex-1 bg-amber-50 dark:bg-stone-950">
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <NoteEditor
          initialContent={note.content}
          onChangeContent={handleChangeContent}
        />
      </KeyboardAvoidingView>
    </View>
  );
}

export default React.memo(NotePage);
