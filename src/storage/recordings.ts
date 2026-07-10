import { deleteRecordings } from '../server/controllers/audioController';

/**
 * Recording-file lifecycle glue for the storage layer.
 *
 * A /record card stores its clip as a file in the app's internal cache and keeps
 * the path inside the card's `<!--ai … -->` marker in the page's markdown. The
 * card's own delete button releases that file, but deleting the whole *page* (or
 * a notebook, which cascades to its pages) tears the markdown down in SQL without
 * ever running the card handler — so those files would orphan in the cache until
 * the OS maybe evicts them. deletePage/deleteNotebook call cleanupRecordings with
 * the doomed content first to reclaim them.
 */

// A record marker is a multi-line HTML comment block; pull the `file:` header out
// of any block whose `kind:` is `record`. (Records are always the multi-line
// form — the legacy single-line base64 marker predates this card, so ignore it.)
const AI_BLOCK_RE = /<!--ai[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*-->/g;
const KIND_RECORD_RE = /^kind:[ \t]*record[ \t]*$/m;
const FILE_RE = /^file:[ \t]?(.*)$/m;
// `kind:`/`file:` are header lines, which always precede any `[user]`/`[agent]`/
// `[backup]` section. Scanning only the header region stops a crafted ask/chat
// ANSWER (e.g. one literally containing "kind: record\nfile: …") from being
// mistaken for a real record marker and deleting an unrelated file.
const SECTION_RE = /^\[(?:user|agent|backup)\][ \t]*$/m;

function headerRegion(body: string): string {
  const m = SECTION_RE.exec(body);
  return m ? body.slice(0, m.index) : body;
}

/** The cache-file paths of every /record card in a page's markdown content. */
export function extractRecordingFiles(content: string): string[] {
  const files: string[] = [];
  let m: RegExpExecArray | null;
  AI_BLOCK_RE.lastIndex = 0;
  while ((m = AI_BLOCK_RE.exec(content)) !== null) {
    const body = headerRegion(m[1]);
    if (!KIND_RECORD_RE.test(body)) continue;
    const fm = FILE_RE.exec(body);
    if (!fm) continue;
    // Reverse the marker's single-line escaping (see aiMarker.js escLine); real
    // paths never contain these, but be symmetric in case one ever does.
    const path = fm[1].replace(/\\n/g, '\n').replace(/--&gt;/g, '-->').trim();
    if (path) files.push(path);
  }
  return files;
}

/**
 * Best-effort: delete the cache files backing any /record cards in `content`.
 * Fire-and-forget — page deletion must not block on (or fail because of) file IO.
 */
export function cleanupRecordings(content: string): void {
  const files = extractRecordingFiles(content);
  if (files.length) {
    deleteRecordings(files).catch(() => {});
  }
}
