/**
 * Run a promise we intentionally don't await (e.g. optimistic persistence),
 * logging failures instead of silently swallowing them. Centralizing this keeps
 * call sites readable and gives us one place to add retry/telemetry later.
 */
export function fireAndForget(
  promise: Promise<unknown>,
  context: string,
): void {
  promise.catch(error => {
    console.warn(`[NestNote] ${context} failed:`, error);
  });
}
