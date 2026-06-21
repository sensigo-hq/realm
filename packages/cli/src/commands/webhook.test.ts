// Tests for the removed `realm webhook` alias — it must error and point users to `realm listen`.
// (The legacy server — checkWebhookSignature / isDuplicate / startWebhookServer — was removed; its
//  GitHub flow is now covered by `realm listen` + a trigger: block, proven byte-parity-equivalent in
//  listen-github-parity.test.ts.)
import { describe, it, expect, vi, afterEach } from 'vitest';
import { webhookCommand } from './webhook.js';

afterEach(() => vi.restoreAllMocks());

describe('realm webhook (removed alias)', () => {
  it('prints a migration error pointing to `realm listen` and exits non-zero', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);

    await expect(webhookCommand.parseAsync([], { from: 'user' })).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/realm listen/);
  });

  it('tolerates legacy flags (does not crash on --workflow/--port before erroring)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);

    await expect(
      webhookCommand.parseAsync(['--workflow', 'x', '--port', '3000'], { from: 'user' }),
    ).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
