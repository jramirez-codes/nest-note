/**
 * Collision-resistant id generator.
 *
 * Kept dependency-free on purpose; swap for `uuid`/`nanoid` later without
 * touching call sites. The timestamp prefix keeps ids roughly sortable by
 * creation time, which is convenient for debugging.
 */
export function createId(): string {
  const time = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `${time}-${random}`;
}
