import React, { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { Note } from '../types/note';
import { formatNoteDate } from '../utils/date';
import ConfirmDialog from './ConfirmDialog';

interface NoteHeaderProps {
  /** The note on the current page, or null on the trailing "new note" sheet. */
  note: Note | null;
  /** 1-based page number for display. */
  pageNumber: number;
  totalPages: number;
  onDelete: (id: string) => void;
}

/**
 * Fixed chrome above the pager, showing the current page's number, date and a
 * delete action. It stays put while pages turn beneath it, so it is not part of
 * the swipe gesture.
 */
function NoteHeader({ note, pageNumber, totalPages, onDelete }: NoteHeaderProps) {
  const [confirmVisible, setConfirmVisible] = useState(false);

  const requestDelete = useCallback(() => setConfirmVisible(true), []);
  const cancelDelete = useCallback(() => setConfirmVisible(false), []);
  const confirmDelete = useCallback(() => {
    setConfirmVisible(false);
    if (note) onDelete(note.id);
  }, [note, onDelete]);

  return (
    <View className="flex-row items-center justify-between border-b border-border px-6 py-3">
      {note ? (
        <>
          <Text className="text-xs font-semibold uppercase tracking-wider text-faint">
            Page {pageNumber} / {totalPages}
          </Text>
          <Text className="text-center text-xs text-muted">
            {formatNoteDate(note.createdAt)}
          </Text>
          <Pressable
            onPress={requestDelete}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Delete note">
            <Text className="text-xs font-semibold text-danger">Delete</Text>
          </Pressable>
        </>
      ) : (
        <Text className="flex-1 text-center text-xs font-semibold uppercase tracking-wider text-faint">
          New page
        </Text>
      )}

      <ConfirmDialog
        visible={confirmVisible}
        title="Delete page"
        message="Are you sure you want to delete this page? This cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        destructive
        onConfirm={confirmDelete}
        onCancel={cancelDelete}
      />
    </View>
  );
}

export default React.memo(NoteHeader);
