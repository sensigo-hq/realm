// slack-response.ts — #729 PR-4 (02 §Transport): the ONE stub response for every Slack `fetch` stub
// in the CLI's Slack cells. It is a FULL Response — `status`, `ok`, `headers`, `json()`, `text()` —
// so the notifier's verdict reads what Slack would send: a webhook's status and body text, the Web
// API's `ok`/`error`, a `Retry-After` header. Each read builds its body afresh, so one stub can
// answer many calls (a real Response's body can be read only once). Fakes only.

export interface SlackResponseInit {
  /** The HTTP status; 200 when absent. */
  status?: number;
  /** The Response's `ok`; derived from the status when absent. */
  ok?: boolean;
  /** The JSON body (the Web API's `{ ok, ts, error }`); its text is its JSON. */
  json?: unknown;
  /** The body as text (a webhook's `ok` or `invalid_payload`). */
  text?: string;
  /** Response headers (`Retry-After`). */
  headers?: Record<string, string>;
}

export function slackResponse(init: SlackResponseInit = {}): Response {
  const status = init.status ?? 200;
  const text = init.text ?? (init.json !== undefined ? JSON.stringify(init.json) : '');
  return {
    status,
    ok: init.ok ?? (status >= 200 && status < 300),
    headers: new Headers(init.headers ?? {}),
    json: async () => (init.json !== undefined ? init.json : (JSON.parse(text) as unknown)),
    text: async () => text,
  } as unknown as Response;
}
