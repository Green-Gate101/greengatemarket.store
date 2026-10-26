/**
 * Request bodies are untrusted: broken JSON, `null`, a list or a bare value
 * must answer 400 — never a 500 "server error" (which also pollutes the
 * error logs and the monitor). Routes read their JSON body with
 * readJsonObject() and answer invalidJsonBody() when it returns null.
 */
export async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return null;
  }
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

export function invalidJsonBody(): Response {
  return Response.json({ error: 'The request could not be read. Please refresh the page and try again.' }, { status: 400 });
}
