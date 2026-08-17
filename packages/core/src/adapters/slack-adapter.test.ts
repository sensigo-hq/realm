import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackAdapter } from './slack-adapter.js';
import { WorkflowError } from '../types/workflow-error.js';

const WEBHOOK_URL = 'https://hooks.slack.com/services/test';

function makeMockResponse(status: number, body = 'ok'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

describe('SlackAdapter', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  it('create(post_message, { text }) posts correct JSON and returns { status: 200, data: { ok: true } }', async () => {
    mockFetch.mockResolvedValue(makeMockResponse(200));
    const adapter = new SlackAdapter('slack', { webhook_url: WEBHOOK_URL });
    const result = await adapter.create('post_message', { text: 'hello' }, {});
    expect(result).toEqual({ status: 200, data: { ok: true } });
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(WEBHOOK_URL);
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body as string)).toEqual({ text: 'hello' });
  });

  it('create(post_message, { text, blocks }) includes blocks in body', async () => {
    mockFetch.mockResolvedValue(makeMockResponse(200));
    const adapter = new SlackAdapter('slack', { webhook_url: WEBHOOK_URL });
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: '*hello*' } }];
    await adapter.create('post_message', { text: 'msg', blocks }, {});
    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body['blocks']).toEqual(blocks);
    expect(body['text']).toBe('msg');
  });

  // issue #287: `text` is REQUIRED here, so this was never a silent-drop site. The absent
  // contract above is PRESERVED verbatim; only the mistyped case gains the expected/found
  // grammar (it used to collapse into the same "is required" message).
  it('(#287) a MISTYPED text reports expected/found, and still uses ADAPTER_VALIDATION_FAILED', async () => {
    const adapter = new SlackAdapter('slack', { webhook_url: WEBHOOK_URL });
    await expect(adapter.create('post_message', { text: 42 }, {})).rejects.toMatchObject({
      code: 'ADAPTER_VALIDATION_FAILED',
      message:
        "adapter 'slack' operation 'post_message': param 'text' — expected string, found number",
    });
  });

  it('(#287) a NULL text is treated as absent — the required-param message, not a type error', async () => {
    const adapter = new SlackAdapter('slack', { webhook_url: WEBHOOK_URL });
    await expect(adapter.create('post_message', { text: null }, {})).rejects.toMatchObject({
      code: 'ADAPTER_VALIDATION_FAILED',
      message: 'SlackAdapter: text is required for post_message',
    });
  });

  it('create(post_message, {}) throws ADAPTER_VALIDATION_FAILED when text is absent', async () => {
    const adapter = new SlackAdapter('slack', { webhook_url: WEBHOOK_URL });
    await expect(adapter.create('post_message', {}, {})).rejects.toMatchObject({
      code: 'ADAPTER_VALIDATION_FAILED',
    });
    await expect(adapter.create('post_message', {}, {})).rejects.toBeInstanceOf(WorkflowError);
  });

  it('fetch() throws ADAPTER_OP_UNSUPPORTED', async () => {
    const adapter = new SlackAdapter('slack', { webhook_url: WEBHOOK_URL });
    await expect(adapter.fetch('anything', {}, {})).rejects.toMatchObject({
      code: 'ADAPTER_OP_UNSUPPORTED',
    });
    await expect(adapter.fetch('anything', {}, {})).rejects.toBeInstanceOf(WorkflowError);
  });

  it('update() throws ADAPTER_OP_UNSUPPORTED', async () => {
    const adapter = new SlackAdapter('slack', { webhook_url: WEBHOOK_URL });
    await expect(adapter.update('anything', {}, {})).rejects.toMatchObject({
      code: 'ADAPTER_OP_UNSUPPORTED',
    });
    await expect(adapter.update('anything', {}, {})).rejects.toBeInstanceOf(WorkflowError);
  });

  it('HTTP non-200 response throws ADAPTER_REQUEST_FAILED', async () => {
    mockFetch.mockResolvedValue(makeMockResponse(400));
    const adapter = new SlackAdapter('slack', { webhook_url: WEBHOOK_URL });
    await expect(adapter.create('post_message', { text: 'hi' }, {})).rejects.toMatchObject({
      code: 'ADAPTER_REQUEST_FAILED',
    });
    await expect(adapter.create('post_message', { text: 'hi' }, {})).rejects.toBeInstanceOf(
      WorkflowError,
    );
  });

  it('network error throws ADAPTER_REQUEST_FAILED', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const adapter = new SlackAdapter('slack', { webhook_url: WEBHOOK_URL });
    await expect(adapter.create('post_message', { text: 'hi' }, {})).rejects.toMatchObject({
      code: 'ADAPTER_REQUEST_FAILED',
    });
  });

  it('AbortError from fetch throws STEP_ABORTED (issue A3 — standardized abort mapping, matching every other network adapter)', async () => {
    mockFetch.mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'));
    const adapter = new SlackAdapter('slack', { webhook_url: WEBHOOK_URL });
    await expect(adapter.create('post_message', { text: 'hi' }, {})).rejects.toMatchObject({
      code: 'STEP_ABORTED',
    });
    await expect(adapter.create('post_message', { text: 'hi' }, {})).rejects.toBeInstanceOf(
      WorkflowError,
    );
  });
});
