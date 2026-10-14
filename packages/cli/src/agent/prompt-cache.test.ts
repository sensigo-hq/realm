// prompt-cache.test.ts — issue #600 PR 2 (C1, G14 and G19b's counting half): the flag's parser on
// both commands, the setting a drive resolves, and the count of steps a setting applies to. On a
// failing CI host each cell prints the resolved setting, the parser's verdict or the counts: test
// values only.
import { describe, expect, it } from 'vitest';
import { InvalidArgumentError } from 'commander';
import type { StepDefinition, WorkflowDefinition } from '@sensigo/realm';
import { cacheableStepCounts, parsePromptCache, resolvePromptCache } from './prompt-cache.js';
import { agentCommand } from '../commands/agent.js';
import { listenCommand } from '../commands/listen.js';

describe('resolvePromptCache (issue #600 PR 2, C1)', () => {
  // One cell per row of C1's table. (a) red when the listen child's default is 5m, or a stated
  // flag loses to a default; (b) prints the resolved setting.
  it.each([
    [
      { flag: '1h' as const, spawnedByListen: false },
      { value: '1h', source: 'stated', by: 'realm agent' },
    ],
    [
      { flag: undefined, spawnedByListen: false },
      { value: '5m', source: 'runner_default', by: 'realm agent' },
    ],
    [
      { flag: 'off' as const, spawnedByListen: true },
      { value: 'off', source: 'stated', by: 'realm listen' },
    ],
    [
      { flag: undefined, spawnedByListen: true },
      { value: '1h', source: 'runner_default', by: 'realm listen' },
    ],
  ])('%j resolves to %j', (input, expected) => {
    expect(resolvePromptCache(input)).toEqual(expected);
  });
});

describe('parsePromptCache (issue #600 PR 2, C1)', () => {
  // (a) red when the parser accepts any string; (b) prints the value and what the parser did.
  it.each(['5', '2h', 'OFF', ''])('refuses %j with the flag message', (value) => {
    let thrown: unknown;
    try {
      parsePromptCache(value);
    } catch (err) {
      thrown = err;
    }
    expect({
      value,
      refused: thrown instanceof InvalidArgumentError,
      message: (thrown as Error)?.message,
    }).toEqual({
      value,
      refused: true,
      message: '--prompt-cache must be off, 5m or 1h.',
    });
  });

  it.each(['off', '5m', '1h'])('accepts %j', (value) => {
    expect(parsePromptCache(value)).toBe(value);
  });

  // (a) red when either command parses the flag with anything but this parser (or not at all);
  // (b) prints which commands carry it.
  it('both commands parse --prompt-cache with this one parser, and neither gives it a default', () => {
    const of = (cmd: typeof agentCommand) => cmd.options.find((o) => o.long === '--prompt-cache');
    const agent = of(agentCommand);
    const listen = of(listenCommand);
    expect({
      agent: agent?.parseArg === parsePromptCache,
      listen: listen?.parseArg === parsePromptCache,
      defaults: [agent?.defaultValue, listen?.defaultValue],
    }).toEqual({ agent: true, listen: true, defaults: [undefined, undefined] });
  });
});

describe('cacheableStepCounts (issue #600 PR 2, C1)', () => {
  const step = (s: Partial<StepDefinition>): StepDefinition =>
    ({ description: 'S.', execution: 'agent', ...s }) as StepDefinition;
  const wf = (steps: Record<string, StepDefinition>): Pick<WorkflowDefinition, 'steps'> => ({
    steps,
  });

  // Per step shape. (a) red when an empty tools list counts as tools, a tools step counts as
  // single-shot, or a non-agent step is counted; (b) prints the counts.
  it('counts agent steps by path: no tools or an empty list is single-shot; any tool is withTools', () => {
    expect(
      cacheableStepCounts(
        wf({
          plain: step({}),
          empty: step({ tools: [] }),
          tooled: step({ tools: ['srv:op'] }),
          auto: step({ execution: 'auto' }),
          guard: step({ execution: 'guard' }),
          autoWithTools: step({ execution: 'auto', tools: ['srv:op'] }),
        }),
      ),
    ).toEqual({ singleShot: 2, withTools: 1 });
    expect(cacheableStepCounts(wf({ auto: step({ execution: 'auto' }) }))).toEqual({
      singleShot: 0,
      withTools: 0,
    });
    expect(cacheableStepCounts(wf({ t: step({ tools: ['srv:a', 'srv:b'] }) }))).toEqual({
      singleShot: 0,
      withTools: 1,
    });
  });
});
