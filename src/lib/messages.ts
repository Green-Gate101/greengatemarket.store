/**
 * Admin ↔ seller messages are plain text: control characters (except new
 * lines and tabs) are removed, runs of blank lines collapsed, length capped.
 * Rendering is plain React text (never HTML), so markup is shown, not run.
 */
export const MESSAGE_MAX = 2000;

export function cleanMessageText(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'Write a message first.' };
  const value = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  if (!value) return { ok: false, error: 'Write a message first.' };
  if (value.length > MESSAGE_MAX) return { ok: false, error: `Keep messages under ${MESSAGE_MAX} characters.` };
  return { ok: true, value };
}
