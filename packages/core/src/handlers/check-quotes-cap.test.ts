// check-quotes-cap.test.ts — the warning's cap and its remainder come from #759's shared exports,
// never a local copy (issue #760, rail 4). The module is mocked in this file only: a cap of 3 and a
// marked remainder, so a local `10` or a recount of the remainder cannot pass. What a failing cell
// prints: the count named and the warning's ending.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../validation/validation-problems.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../validation/validation-problems.js')>()),
  VALIDATION_PROBLEMS_SHOWN: 3,
  renderMore: (total: number, shown: number) => (total <= shown ? '' : `[more ${total}/${shown}]`),
}));

const { CheckQuotesHandler } = await import('./check-quotes.js');

describe('check_quotes — the cap is #759’s', () => {
  it('names VALIDATION_PROBLEMS_SHOWN values and ends with renderMore’s phrase', async () => {
    const candidates = Array.from({ length: 5 }, (_, i) => ({
      field: `f${i + 1}`,
      value: 'x',
      quote: 'nothing of this is in the source at all',
    }));
    const result = await new CheckQuotesHandler().execute(
      { params: {} },
      {
        run_id: 'r',
        run_params: {},
        config: { source_step: 'doc', candidates_step: 'extract' },
        resources: { doc: { text: 'A short source.' }, extract: { candidates } },
      },
    );
    const warn = result.warn?.message ?? '';
    // (a) red when the handler caps at its own 10, or builds "and N more" itself; (b) prints the
    //     count named and whether the ending is renderMore's.
    expect({ named: warn.match(/f\d+ — /g)?.length, ends: warn.endsWith('; [more 5/3].') }).toEqual(
      {
        named: 3,
        ends: true,
      },
    );
  });
});
