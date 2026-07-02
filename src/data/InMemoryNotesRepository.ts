import type { Note } from '../types/note';
import type { NotesRepository } from './NotesRepository';

/**
 * In-memory {@link NotesRepository}. Data lives for the lifetime of the JS
 * runtime only — good enough to build and demo the UI against.
 *
 * When adding persistence, create a sibling implementation (e.g.
 * `AsyncStorageNotesRepository`) that satisfies the same interface and wire it
 * up in `data/index.ts`. Nothing else needs to change.
 */
export class InMemoryNotesRepository implements NotesRepository {
  private notes: Map<string, Note>;

  constructor(seed: Note[] = []) {
    this.notes = new Map(seed.map(note => [note.id, note]));
  }

  async list(): Promise<Note[]> {
    return [...this.notes.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async save(note: Note): Promise<void> {
    this.notes.set(note.id, note);
  }

  async delete(id: string): Promise<void> {
    this.notes.delete(id);
  }
}
