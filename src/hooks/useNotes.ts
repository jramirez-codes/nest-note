import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_NOTEBOOK_ID,
  createPage,
  deletePage,
  listPages,
  updatePage,
} from '../storage';
import type { Note } from '../types/note';
import { fireAndForget } from '../utils/async';
import { createId } from '../utils/id';

/** Newest-created note first, so the freshest page is page 0. */
function byNewestFirst(a: Note, b: Note): number {
  return b.createdAt - a.createdAt;
}

export interface UseNotesResult {
  notes: Note[];
  isLoading: boolean;
  /** Create an empty note, persist it, and return it. */
  createNote: () => Promise<Note>;
  /** Replace a note's content and bump its `updatedAt`. */
  updateNoteContent: (id: string, content: string) => void;
  deleteNote: (id: string) => void;
}

/**
 * Owns note state and mediates every change through the storage layer
 * (`storage/pages`). Notes belong to the default notebook for now; when
 * multiple notebooks land, the notebook id flows in here and nothing else
 * changes.
 *
 * State updates are applied optimistically (local state first, then persisted)
 * so the editor stays responsive; storage is the source of truth on next load.
 */
export function useNotes(
  notebookId: string = DEFAULT_NOTEBOOK_ID,
): UseNotesResult {
  const [notes, setNotes] = useState<Note[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let active = true;
    listPages(notebookId)
      .then(loaded => {
        if (active) {
          setNotes([...loaded].sort(byNewestFirst));
        }
      })
      .finally(() => {
        if (active) {
          setIsLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [notebookId]);

  const createNote = useCallback(async (): Promise<Note> => {
    const timestamp = Date.now();
    const note: Note = {
      id: createId(),
      content: '',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    // Newest first: the fresh note becomes page 0.
    setNotes(prev => [note, ...prev]);
    await createPage(note, notebookId);
    return note;
  }, [notebookId]);

  const updateNoteContent = useCallback((id: string, content: string) => {
    setNotes(prev => {
      const index = prev.findIndex(note => note.id === id);
      if (index === -1) {
        return prev;
      }
      const updated: Note = {
        ...prev[index],
        content,
        updatedAt: Date.now(),
      };
      // Persist without reordering the list — pages should not jump around
      // while the user is typing on them.
      fireAndForget(updatePage(updated), 'save note');
      const next = [...prev];
      next[index] = updated;
      return next;
    });
  }, []);

  const deleteNote = useCallback((id: string) => {
    setNotes(prev => prev.filter(note => note.id !== id));
    fireAndForget(deletePage(id), 'delete note');
  }, []);

  return { notes, isLoading, createNote, updateNoteContent, deleteNote };
}
