import { createMMKV, type MMKV } from 'react-native-mmkv';
import type { Note } from '../types/note';
import type { NotesRepository } from './NotesRepository';

/** Dedicated storage instance so note keys never collide with other features. */
const STORAGE_ID = 'ainotepad.notes';

/** Every note is stored under its own key: `note.<id>` -> JSON. */
const KEY_PREFIX = 'note.';

interface MmkvNotesRepositoryOptions {
  /** Notes written once, only if the store is empty (first launch). */
  seed?: Note[];
  /** Override the MMKV instance id (handy for tests / multiple pads). */
  id?: string;
}

/**
 * Persistent {@link NotesRepository} backed by
 * [react-native-mmkv](https://github.com/mrousavy/react-native-mmkv).
 *
 * Each note is a separate key so a single edit is one small synchronous write
 * rather than re-serializing the whole collection. MMKV is synchronous; we wrap
 * results in promises to satisfy the async repository contract.
 */
export class MmkvNotesRepository implements NotesRepository {
  private readonly storage: MMKV;

  constructor(options: MmkvNotesRepositoryOptions = {}) {
    this.storage = createMMKV({ id: options.id ?? STORAGE_ID });

    if (options.seed?.length && this.noteKeys().length === 0) {
      for (const note of options.seed) {
        this.write(note);
      }
    }
  }

  async list(): Promise<Note[]> {
    const notes: Note[] = [];
    for (const key of this.noteKeys()) {
      const note = this.parse(this.storage.getString(key));
      if (note) {
        notes.push(note);
      }
    }
    return notes.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async save(note: Note): Promise<void> {
    this.write(note);
  }

  async delete(id: string): Promise<void> {
    this.storage.remove(this.keyFor(id));
  }

  private keyFor(id: string): string {
    return `${KEY_PREFIX}${id}`;
  }

  private noteKeys(): string[] {
    return this.storage.getAllKeys().filter(key => key.startsWith(KEY_PREFIX));
  }

  private write(note: Note): void {
    this.storage.set(this.keyFor(note.id), JSON.stringify(note));
  }

  /** Parse a stored value into a Note, tolerating missing/corrupt entries. */
  private parse(raw: string | undefined): Note | null {
    if (!raw) {
      return null;
    }
    try {
      const value = JSON.parse(raw) as Partial<Note>;
      if (
        typeof value.id === 'string' &&
        typeof value.content === 'string' &&
        typeof value.createdAt === 'number' &&
        typeof value.updatedAt === 'number'
      ) {
        return value as Note;
      }
    } catch {
      // Ignore malformed entries rather than crashing the whole load.
    }
    return null;
  }
}
