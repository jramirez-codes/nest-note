import React, { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Plus } from 'lucide-react-native';
import type { Note } from '../../types/note';
import { useTheme } from '../../theme/colors';
import { formatNoteDate } from '../../utils/date';
import ConfirmDialog from '../modals/ConfirmDialog';

/** Greetings for the dashboard header, rotated one per day. */
const GREETINGS = [
  'Welcome'
];

/** Pick today's greeting, stable for the whole day and rotating every 24h. */
function greetingForToday(): string {
  const dayIndex = Math.floor(Date.now() / 86_400_000);
  return GREETINGS[dayIndex % GREETINGS.length];
}

interface NoteHeaderProps {
  /** The note on the current page, or null on the trailing dashboard page. */
  note: Note | null;
  /** 1-based page number for display. */
  pageNumber: number;
  totalPages: number;
  onDelete: (id: string) => void;
  /** Create a fresh note — surfaced as the dashboard page's header action. */
  onCreateNote: () => void;
  /**
   * Title of a read-only subject page (a virtual page pulled from a swapped-to notebook).
   * When set — and there's no editable `note` — the header shows the page number and title
   * with no delete/new-note action, since server-owned pages aren't edited on the phone.
   */
  readOnlyTitle?: string;
}

/**
 * Fixed chrome above the pager, showing the current page's number, date and a
 * delete action. It stays put while pages turn beneath it, so it is not part of
 * the swipe gesture. On the trailing dashboard page it swaps the delete action
 * for a "New note" action that sits in the same slot, at the same size.
 *
 * While a dashboard card is dragged, the screen fades this whole bar out and
 * reveals a red delete banner in its place (see NotebookScreen).
 */
function NoteHeader({
  note,
  pageNumber,
  totalPages,
  onDelete,
  onCreateNote,
  readOnlyTitle,
}: NoteHeaderProps) {
  const colors = useTheme();
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
      ) : readOnlyTitle !== undefined ? (
        <>
          <Text className="text-xs font-semibold uppercase tracking-wider text-faint">
            Page {pageNumber} / {totalPages}
          </Text>
        </>
      ) : (
        <>
          <Text className="text-xs font-semibold uppercase tracking-wider text-faint">
            {greetingForToday()}
          </Text>
          <Pressable
            onPress={onCreateNote}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Add a new note"
            className="flex-row items-center gap-1">
            <Plus size={14} color={colors.accent} strokeWidth={2.5} />
            <Text className="text-xs font-semibold text-accent">New note</Text>
          </Pressable>
        </>
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
