/** Format a timestamp for a note page header, e.g. "Jul 1, 2026 · 3:42 PM". */
export function formatNoteDate(timestamp: number): string {
  const date = new Date(timestamp);
  const day = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const time = date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${day} · ${time}`;
}
