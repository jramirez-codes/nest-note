import type { Note } from '../types/note';

/**
 * Persistence boundary for notes.
 *
 * The app depends only on this interface, never on a concrete store. That lets
 * us start with an in-memory implementation today and swap in AsyncStorage, a
 * local database, or a synced backend later without changing UI or hooks.
 *
 * All methods are async so the contract already matches a real (I/O-bound)
 * store — callers never need to change when the backing implementation does.
 */
export interface NotesRepository {
  /** Return all notes, newest first. */
  list(): Promise<Note[]>;

  /** Insert or update a note (keyed by `id`). */
  save(note: Note): Promise<void>;

  /** Remove a note by id. No-op if it does not exist. */
  delete(id: string): Promise<void>;
}
