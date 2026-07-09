import { getDb } from './db';

/**
 * Externalized storage for bulky AI-card bodies.
 *
 * Each interactive card in a note (`/code`, `/run`, `/clean`, `/ask`, `/chat`)
 * keeps a light marker in the page markdown — `kind`, `id`, `status`, … — while
 * its heavy body (a transcript, terminal output, a backup, an answer) lives here
 * keyed by the card's marker id. This keeps `pages.content` small so it isn't
 * expensive to serialize over the WebView bridge on every keystroke; the editor
 * bundles these back in on load (see `NoteEditorWebView` → `window.__setPayloads`)
 * and writes them back as cards stream (`window` `cardPayload` messages).
 *
 * Rows are owned by a page (`page_id`) with an ON DELETE CASCADE, so deleting a
 * page or notebook reclaims its card bodies automatically — no manual cleanup
 * like `recordings.ts` needs (those blobs live outside SQL).
 */

/** The serialized body of one card, as stored. `payload` is the raw string the
 *  editor persisted (JSON for `/code`+`/chat`, plain text for the rest). */
export interface CardPayload {
  kind: string;
  payload: string;
}

/** Every card body belonging to a page, keyed by card id — the shape the editor
 *  expects for `window.__setPayloads`. */
export async function getPayloadsForPage(
  pageId: string,
): Promise<Record<string, CardPayload>> {
  const result = await getDb().execute(
    'SELECT card_id, kind, payload FROM card_payloads WHERE page_id = ?',
    [pageId],
  );
  const out: Record<string, CardPayload> = {};
  for (const row of result.rows ?? []) {
    out[String(row.card_id)] = {
      kind: String(row.kind),
      payload: String(row.payload),
    };
  }
  return out;
}

/** Insert or replace a card's body. Called as a card finishes (or streams a
 *  durable partial) and on first-open migration of an old inline note. */
export async function upsertPayload(
  cardId: string,
  pageId: string,
  kind: string,
  payload: string,
): Promise<void> {
  await getDb().execute(
    `INSERT INTO card_payloads (card_id, page_id, kind, payload, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(card_id) DO UPDATE SET
       page_id = excluded.page_id,
       kind = excluded.kind,
       payload = excluded.payload,
       updated_at = excluded.updated_at`,
    [cardId, pageId, kind, payload, Date.now()],
  );
}

/** Drop a single card's body (the card's own delete button). Page/notebook
 *  deletion is handled by the FK cascade, not this. No-op if it does not exist. */
export async function deletePayload(cardId: string): Promise<void> {
  await getDb().execute('DELETE FROM card_payloads WHERE card_id = ?', [cardId]);
}
