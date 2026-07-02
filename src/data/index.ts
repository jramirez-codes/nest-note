import { createId } from '../utils/id';
import type { Note } from '../types/note';
import { MmkvNotesRepository } from './MmkvNotesRepository';
import type { NotesRepository } from './NotesRepository';

export type { NotesRepository } from './NotesRepository';

const now = Date.now();

/** A little content so the pad isn't empty on first launch (written once). */
const seedNotes: Note[] = [
  {
    id: createId(),
    content:
      '# Welcome to your pad\n\n' +
      'Swipe left and right to flip through pages.\n\n' +
      'This editor speaks **markdown**:\n' +
      '- *italic* and **bold**\n' +
      '- `inline code`\n' +
      '- > blockquotes\n\n' +
      'Tap the last page to start a fresh note.',
    createdAt: now,
    updatedAt: now,
  },
];

/**
 * The single repository instance the app talks to. Swap the constructed class
 * here to change how notes are stored — call sites depend only on the
 * {@link NotesRepository} interface.
 *
 * Backed by MMKV for on-device persistence; the seed is applied only when the
 * store is empty, so it appears once on first launch and never overwrites the
 * user's notes.
 */
export const notesRepository: NotesRepository = new MmkvNotesRepository({
  seed: seedNotes,
});
