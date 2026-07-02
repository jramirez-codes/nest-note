import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import NewNotePage from '../components/NewNotePage';
import NoteHeader from '../components/NoteHeader';
import NotePage from '../components/NotePage';
import PageIndicator from '../components/PageIndicator';
import PaperPager from '../components/PaperPager';
import type { PaperPagerHandle } from '../components/PaperPager';
import { useNotes } from '../hooks/useNotes';
import type { Note } from '../types/note';
import { fireAndForget } from '../utils/async';

/**
 * A page in the pager is either an existing note or the trailing "new note"
 * sheet. Modeling it as a discriminated union keeps `renderItem` exhaustive.
 */
type Page = { kind: 'note'; note: Note } | { kind: 'new' };

const NEW_PAGE_KEY = '__new_note__';

/**
 * The notebook: a horizontally paged pad the user flips through, one note per
 * page, with a permanent blank sheet at the end for adding notes.
 */
export default function NotebookScreen() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { notes, isLoading, createNote, updateNoteContent, deleteNote } =
    useNotes();

  const pagerRef = useRef<PaperPagerHandle>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  // Set when the user adds a note, so the effect below flips to the new page
  // once it has been committed to the list.
  const pendingFlipToNewNote = useRef(false);

  const pages = useMemo<Page[]>(
    () => [
      ...notes.map(note => ({ kind: 'note' as const, note })),
      { kind: 'new' as const },
    ],
    [notes],
  );

  const handleCreate = useCallback(() => {
    pendingFlipToNewNote.current = true;
    fireAndForget(createNote(), 'create note');
  }, [createNote]);

  // After a create commits, flip to the freshly added note (last note page).
  useEffect(() => {
    if (pendingFlipToNewNote.current && notes.length > 0) {
      pendingFlipToNewNote.current = false;
      pagerRef.current?.flipTo(notes.length - 1);
    }
  }, [notes.length]);

  const keyForIndex = useCallback(
    (index: number) => {
      const page = pages[index];
      return !page || page.kind === 'new' ? NEW_PAGE_KEY : page.note.id;
    },
    [pages],
  );

  const renderPage = useCallback(
    (index: number, isActive: boolean) => {
      const page = pages[index];
      if (!page || page.kind === 'new') {
        return <NewNotePage width={width} onCreate={handleCreate} />;
      }
      return (
        <NotePage
          note={page.note}
          width={width}
          isActive={isActive}
          onChangeContent={updateNoteContent}
        />
      );
    },
    [pages, width, handleCreate, updateNoteContent],
  );

  const currentPage = pages[currentIndex];
  const currentNote =
    currentPage && currentPage.kind === 'note' ? currentPage.note : null;

  return (
    <View
      className="flex-1 bg-background"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}>
      <View className="flex-row items-center justify-between px-6 pb-2 pt-1">
        <Text className="text-xl font-bold text-text">Pad</Text>
        <Text className="text-xs text-faint">
          {notes.length} {notes.length === 1 ? 'note' : 'notes'}
        </Text>
      </View>

      {isLoading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      ) : (
        <>
          <NoteHeader
            note={currentNote}
            pageNumber={currentIndex + 1}
            totalPages={notes.length}
            onDelete={deleteNote}
          />
          <PaperPager
            ref={pagerRef}
            count={pages.length}
            width={width}
            keyForIndex={keyForIndex}
            renderPage={renderPage}
            onIndexChange={setCurrentIndex}
          />
        </>
      )}

      <PageIndicator currentIndex={currentIndex} totalPages={pages.length} />
    </View>
  );
}
