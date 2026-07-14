import React, { useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft, Trash2 } from 'lucide-react-native';
import { useTheme } from '../../theme/colors';
import { deriveTitle, type Note } from '../../types/note';
import ConfirmDialog from '../modals/ConfirmDialog';
import NotePage from './NotePage';

interface ArchivedPageOverlayProps {
  /** The archived page being viewed/edited as a temporary page. */
  note: Note;
  /** Exact page width so the editor fills the sheet. */
  width: number;
  /** The notebook the archived page belongs to (for /record media buckets). */
  notebookId: string;
  /** Close the temporary page. Edits are already saved as they're made. */
  onClose: () => void;
  /** Persist a content edit to the archived page. */
  onChangeContent: (id: string, content: string) => void;
  /** Persist a title edit to the archived page. */
  onSetTitle: (id: string, title: string) => void;
  /** Permanently delete the archived page (from the trash button or `/ingest`). */
  onRemove: () => void;
  /** A tapped wikilink asks to open `title` (in notebook `slug`, or the current one). */
  onOpenPage?: (slug: string, title: string) => void;
}

/**
 * A temporary page opened from the dashboard's Archived section. It's the same
 * editor the pad uses, presented full-screen over everything, so an archived
 * page can be read and edited without living on the pad. Edits save straight to
 * storage as they happen — so leaving (Back, or the system gesture) simply
 * closes it with the changes already persisted to the archive.
 *
 * The page is reachable ONLY here: `/archive` lifts it off the pad and it stays
 * off until deleted. The trash button (and `/ingest`, which files it away) are
 * the only ways to remove it.
 */
export default function ArchivedPageOverlay({
  note,
  width,
  notebookId,
  onClose,
  onChangeContent,
  onSetTitle,
  onRemove,
  onOpenPage,
}: ArchivedPageOverlayProps) {
  const insets = useSafeAreaInsets();
  const colors = useTheme();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const title = note.title.trim() || deriveTitle(note.content);

  return (
    <Modal
      visible
      animationType="slide"
      statusBarTranslucent
      onRequestClose={onClose}>
      <View
        className="flex-1 bg-background"
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}>
        {/* Header: back to the dashboard, the page's title, and a trash button. */}
        <View className="flex-row items-center px-3 pb-2 pt-1">
          <Pressable
            onPress={onClose}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Back to dashboard"
            className="mr-1 h-9 w-9 items-center justify-center rounded-full active:bg-surface">
            <ChevronLeft size={24} color={colors.text} strokeWidth={2} />
          </Pressable>
          <View className="flex-1 pr-2">
            <Text className="text-[11px] font-bold uppercase tracking-wider text-faint">
              Archived
            </Text>
            <Text numberOfLines={1} className="text-lg font-bold text-text">
              {title}
            </Text>
          </View>
          <Pressable
            onPress={() => setConfirmDelete(true)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Delete archived page"
            className="h-9 w-9 items-center justify-center rounded-full active:bg-surface">
            <Trash2 size={20} color={colors.danger} strokeWidth={2} />
          </Pressable>
        </View>

        <NotePage
          note={note}
          width={width}
          isActive
          onChangeContent={onChangeContent}
          onSetTitle={onSetTitle}
          onIngested={onRemove}
          onOpenPage={onOpenPage}
          notebookId={notebookId}
        />
      </View>

      <ConfirmDialog
        visible={confirmDelete}
        title="Delete archived page"
        message={`Permanently delete “${title}”? This can't be undone.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        destructive
        onConfirm={() => {
          setConfirmDelete(false);
          onRemove();
        }}
        onCancel={() => setConfirmDelete(false)}
      />
    </Modal>
  );
}
