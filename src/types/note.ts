/**
 * Core domain model for the notebook.
 *
 * A `Note` is a single page in the pad. `content` holds raw markdown text;
 * everything the UI needs (title, previews) is derived from it so we never
 * store denormalized data that can drift out of sync.
 */
export interface Note {
  id: string;
  /** Raw markdown authored by the user. */
  content: string;
  createdAt: number;
  updatedAt: number;
}

const UNTITLED = 'Untitled note';

/**
 * Derive a human-readable title from a note's content: the first non-empty
 * line, stripped of common markdown heading/list syntax.
 */
export function deriveTitle(content: string): string {
  const firstLine = content
    .split('\n')
    .map(line => line.trim())
    .find(line => line.length > 0);

  if (!firstLine) {
    return UNTITLED;
  }

  const cleaned = firstLine.replace(/^([#>\-*+]|\d+\.)\s*/, '').trim();
  return cleaned.length > 0 ? cleaned : UNTITLED;
}
