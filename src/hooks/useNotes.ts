import { useCallback, useEffect, useState } from 'react';
import { notesRepository } from '../data';
import type { NotesRepository } from '../data';
import type { Note } from '../types/note';
import { fireAndForget } from '../utils/async';
import { createId } from '../utils/id';

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
 * Owns note state and mediates every change through the {@link NotesRepository}.
 *
 * State updates are applied optimistically (local state first, then persisted)
 * so the editor stays responsive; the repository is the source of truth on the
 * next load. The repository is injectable to keep the hook testable.
 */
export function useNotes(
  repository: NotesRepository = notesRepository,
): UseNotesResult {
  const [notes, setNotes] = useState<Note[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let active = true;
    repository
      .list()
      .then(loaded => {
        if (active) {
          setNotes(loaded);
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
  }, [repository]);

  const createNote = useCallback(async (): Promise<Note> => {
    const timestamp = Date.now();
    const note: Note = {
      id: createId(),
      content: '',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    setNotes(prev => [...prev, note]);
    await repository.save(note);
    return note;
  }, [repository]);

  const updateNoteContent = useCallback(
    (id: string, content: string) => {
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
        fireAndForget(repository.save(updated), 'save note');
        const next = [...prev];
        next[index] = updated;
        return next;
      });
    },
    [repository],
  );

  const deleteNote = useCallback(
    (id: string) => {
      setNotes(prev => prev.filter(note => note.id !== id));
      fireAndForget(repository.delete(id), 'delete note');
    },
    [repository],
  );

  return { notes, isLoading, createNote, updateNoteContent, deleteNote };
}
