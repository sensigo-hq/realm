// test-support/callbacks.ts — callback B1a (R1.3), test support only (not published: the package's
// `files` leave `dist/**/test-support/**` out but the three files they name): what the callback
// tests of this package need on a real home. Callback B1b reuses them.
//   - `testSealer`: a sealer whose blob really differs from the key's text and from its raw bytes
//     (each byte of the text XOR 0x5a, after a header naming the master key and the slot), and that
//     answers `undefined` for a blob of another master key or another slot. It records every call.
//   - `plantRun`: writes a run AS GIVEN on a foreign connection, past the store's boundary (the
//     technique of `outbound-ledger.contract.test.ts`, whose own copy stays private to that file).
//   - `plantCallbackRow`: writes one `callbacks` row on a foreign connection.
//   - `makeUnreadable`: overwrites one key slot's sealed bytes and its master key fingerprint on a
//     foreign connection, and throws when no slot was there.
import { REALM_STORE_SCHEMA, type CallbackKeySlotName, type RunRecord } from '@sensigo/realm';
import type { CallbackKeySealer } from '../callback-keys.js';
import { insertRunRecord, splitRunRecord, writeRunUpdate } from '../run-rows.js';
import { openForeignConnection } from './foreign-connection.js';

/** One call a test sealer saw: which, and the context it was given. */
export interface SealerCall {
  readonly call: 'seal' | 'unseal';
  readonly ctx: { readonly workflow_id: string; readonly host: string; readonly slot: string };
}

const MASK = 0x5a;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The blob's header: the master key's fingerprint and the slot's place, then a newline. */
function header(masterFp: string, ctx: SealerCall['ctx']): Uint8Array {
  return encoder.encode(`sealed:${masterFp}:${ctx.workflow_id}:${ctx.host}:${ctx.slot}\n`);
}

/** A test sealer under the master key fingerprint `masterFp` (see the module comment). */
export function testSealer(masterFp = 'c0ffee01'): CallbackKeySealer & {
  readonly calls: SealerCall[];
} {
  const calls: SealerCall[] = [];
  return {
    masterFp,
    calls,
    seal(text, ctx) {
      calls.push({ call: 'seal', ctx: { ...ctx } });
      const head = header(masterFp, ctx);
      const body = encoder.encode(text).map((byte) => byte ^ MASK);
      const blob = new Uint8Array(head.length + body.length);
      blob.set(head, 0);
      blob.set(body, head.length);
      return blob;
    },
    unseal(blob, ctx) {
      calls.push({ call: 'unseal', ctx: { ...ctx } });
      const head = header(masterFp, ctx);
      const bytes = new Uint8Array(blob);
      if (bytes.length < head.length || !head.every((byte, i) => bytes[i] === byte))
        return undefined;
      return decoder.decode(bytes.subarray(head.length).map((byte) => byte ^ MASK));
    },
  };
}

/** The version fence's exact statement, re-created after a plant. */
const FENCE = REALM_STORE_SCHEMA.find((s) => s.startsWith('CREATE TRIGGER runs_version_fence '));

/**
 * Writes `record` into the home's file AS GIVEN: a new id is inserted, a stored one replaced at the
 * record's own version, in one transaction on a foreign connection.
 */
export async function plantRun(home: string, record: RunRecord): Promise<void> {
  if (FENCE === undefined)
    throw new Error("the store's schema holds no runs_version_fence trigger");
  const c = await openForeignConnection(home);
  try {
    c.exec('BEGIN IMMEDIATE');
    try {
      if (c.prepare('SELECT 1 FROM runs WHERE id = ?').get(record.id) === undefined) {
        insertRunRecord(c, record);
      } else {
        const split = splitRunRecord(record);
        c.exec('DROP TRIGGER runs_version_fence');
        writeRunUpdate(c, record.id, split.core, {
          prepared: { entries: split.entries, fields: split.fields },
        });
        c.exec(FENCE);
      }
      c.exec('COMMIT');
    } catch (err) {
      c.exec('ROLLBACK');
      throw err;
    }
  } finally {
    c.close();
  }
}

/** One `callbacks` row to plant: the columns a test sets, the rest NULL. */
export interface PlantedCallbackRow {
  readonly run_id: string;
  readonly status: string;
  readonly url?: string;
  readonly body?: string;
  readonly webhook_id?: string;
}

/** Writes one `callbacks` row on a foreign connection, stamped 2026-01-01T00:00:00.000Z. */
export async function plantCallbackRow(home: string, row: PlantedCallbackRow): Promise<void> {
  const at = '2026-01-01T00:00:00.000Z';
  const c = await openForeignConnection(home);
  try {
    c.prepare(
      'INSERT INTO callbacks (run_id, workflow_id, host, webhook_id, status, attempts, created_at, next_attempt_at, url, body) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)',
    ).run(
      row.run_id,
      'wf-callback',
      'hooks.example:443',
      row.webhook_id ?? `webhook-${row.run_id}`,
      row.status,
      at,
      at,
      row.url ?? null,
      row.body ?? null,
    );
  } finally {
    c.close();
  }
}

/**
 * Makes one key slot unreadable, as a sealing store reports a slot it cannot unseal: its sealed bytes
 * are overwritten and its master key fingerprint set to `masterFp`. Throws when no such slot exists.
 * Reads no clock.
 */
export async function makeUnreadable(
  home: string,
  workflowId: string,
  host: string,
  slot: CallbackKeySlotName,
  masterFp: string,
): Promise<void> {
  const c = await openForeignConnection(home);
  try {
    const { changes } = c
      .prepare(
        "UPDATE callback_keys SET sealed = X'00', master_fp = ? WHERE workflow_id = ? AND host = ? AND slot = ?",
      )
      .run(masterFp, workflowId, host, slot);
    if (Number(changes) === 0)
      throw new Error(`No ${slot} key slot of (${workflowId}, ${host}) to make unreadable.`);
  } finally {
    c.close();
  }
}
