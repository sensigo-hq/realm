// #729 PR-3 (02 M-1, M-2, M-5; 03 L-2; 04 "a lint cell"): the egress and drive-path lints, and the
// seal-writer selectors that every later `no-restricted-syntax` block must spread. A flat config's
// later block REPLACES an earlier one's selector list in the files it matches, so each block is
// proved to still carry the seal rule. Each snippet is linted in memory at a path the block matches
// (no file is written). Each assertion names (a) the change that turns it red and (b) what it prints:
// the rule hits per snippet.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** The `no-restricted-syntax` messages a snippet draws at `path` (repo-relative). */
async function hits(path: string, code: string): Promise<string[]> {
  const eslint = new ESLint({
    cwd: ROOT,
    // The snippets are not part of any tsconfig project: the selectors need no types.
    overrideConfig: [
      { languageOptions: { parserOptions: { project: null, projectService: false } } },
    ],
  });
  const [result] = await eslint.lintText(code, { filePath: join(ROOT, path) });
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === 'no-restricted-syntax')
    .map((m) => m.message.slice(0, 40));
}

const SEAL = 'const r = { terminal_state: true };\nexport default r;\n';

describe('#729 PR-3 — the lints', () => {
  it('the seal-writer selector still fires under tools/** and on the drive path', async () => {
    const at = {
      tools: await hits('packages/mcp-server/src/tools/zz-lint-probe.ts', SEAL),
      mcp: await hits('packages/mcp-server/src/zz-lint-probe.ts', SEAL),
      drive: await hits('packages/cli/src/agent/zz-lint-probe.ts', SEAL),
      listen: await hits('packages/cli/src/commands/listen.ts', SEAL),
      composer: await hits('packages/cli/src/commands/ways-renderer.ts', SEAL),
    };
    // (a) red when a later block stops spreading SEAL_WRITER_SELECTORS; (b) prints the hits.
    expect(Object.fromEntries(Object.entries(at).map(([k, v]) => [k, v.length]))).toEqual({
      tools: 1,
      mcp: 1,
      drive: 1,
      listen: 1,
      composer: 1,
    });
  });

  it('M-2: a hand-built text block in tools/** is refused; M-1: `as unknown as` inside toolContentOf', async () => {
    const text = "export const r = { content: [{ type: 'text', text: 'x' }] };\n";
    const cast =
      'declare const toolContentOf: (a: unknown, b: unknown) => unknown;\ndeclare const x: number;\nexport const r = toolContentOf(x as unknown as Record<string, unknown>, {});\n';
    // (a) red when either selector is dropped; (b) prints the counts.
    expect({
      text: (await hits('packages/mcp-server/src/tools/zz-lint-probe.ts', text)).length,
      textOutsideTools: (await hits('packages/mcp-server/src/render-reply.ts', text)).length,
      cast: (await hits('packages/mcp-server/src/tools/zz-lint-probe.ts', cast)).length,
    }).toEqual({ text: 1, textOutsideTools: 0, cast: 1 });
  });

  it('M-5, F8, G6: the elicit leaves only through elicitDisclosedWith’s one bind in server.ts', async () => {
    // `s` is typed without naming the method, so each snippet draws only the hit it is about.
    const S = 'declare const s: Record<string, (...a: unknown[]) => unknown>;\n';
    const W = 'declare function elicitDisclosedWith(f: unknown, d: unknown): unknown;\n';
    const direct = `${S}s.elicitInput({});\n`;
    const method = `${S}s.request({ method: 'elicitation/create' });\n`;
    // A template spelling it whole (a composed one, `elicitation/${k}`, is a recorded bypass).
    const methodTemplate = `${S}s.request({ method: \`elicitation/create\` });\n`;
    const site = `${S}${W}export const e = elicitDisclosedWith((p: unknown) => s.elicitInput(p) as unknown, {});\n`;
    // Inside the wrapper's arguments, but not the one bind: a closure that keeps the raw call.
    const besideSite = `${S}${W}export const e = elicitDisclosedWith(() => { const f = s.elicitInput; return f; }, {});\n`;
    // (a) red when the identifier rule, the method-string rule (literal or template), the exact
    //     site, or render-reply.ts's coverage is removed; (b) prints the counts.
    expect({
      tool: (await hits('packages/mcp-server/src/tools/zz-lint-probe.ts', direct)).length,
      method: (await hits('packages/mcp-server/src/tools/zz-lint-probe.ts', method)).length,
      methodTemplate: (await hits('packages/mcp-server/src/zz-lint-probe.ts', methodTemplate))
        .length,
      server: (await hits('packages/mcp-server/src/server.ts', direct)).length,
      serverSite: (await hits('packages/mcp-server/src/server.ts', site)).length,
      serverBesideSite: (await hits('packages/mcp-server/src/server.ts', besideSite)).length,
      siteElsewhere: (await hits('packages/mcp-server/src/form-path.ts', site)).length,
      renderReply: (await hits('packages/mcp-server/src/render-reply.ts', direct)).length,
    }).toEqual({
      tool: 1,
      method: 1,
      methodTemplate: 1,
      server: 1,
      serverSite: 0,
      serverBesideSite: 1,
      siteElsewhere: 1,
      renderReply: 1,
    });
  });

  it("L-2: the writer's context only inside a print call; a realm command template through ctx.cmd", async () => {
    const ctxOutside =
      "declare const writerCtx: () => { cmd(t: string): string };\nexport const kept = writerCtx().cmd('x');\n";
    const ctxInside =
      "declare const writerCtx: () => { cmd(t: string): string };\nconsole.log(writerCtx().cmd('x'));\n";
    const template = 'declare const id: string;\nexport const s = `realm run inspect ${id}`;\n';
    const throughCmd =
      'declare const id: string;\ndeclare const ctx: { cmd(t: string): string };\nexport const s = ctx.cmd(`realm run inspect ${id}`);\n';
    const P = 'packages/cli/src/agent/zz-lint-probe.ts';
    // (a) red when either L-2 selector is dropped or misfires; (b) prints the counts.
    expect({
      ctxOutside: (await hits(P, ctxOutside)).length,
      ctxInside: (await hits(P, ctxInside)).length,
      template: (await hits(P, template)).length,
      throughCmd: (await hits(P, throughCmd)).length,
      slackOutsideScope: (
        await hits('packages/cli/src/agent/gate/slack-gate-notifier.ts', template)
      ).length,
    }).toEqual({ ctxOutside: 1, ctxInside: 0, template: 1, throughCmd: 0, slackOutsideScope: 0 });
  });

  it("F26: PLAIN.cmd on the drive path is refused; run-attach's one use names its reason", async () => {
    const plain =
      "declare const PLAIN: { cmd(t: string): string };\nconsole.log(PLAIN.cmd('realm run drain x'));\n";
    const RUN_ATTACH = 'packages/cli/src/agent/run-attach.ts';
    const source = readFileSync(join(ROOT, RUN_ATTACH), 'utf8');
    const reason = /^.*eslint-disable-next-line no-restricted-syntax -- .*\(#729 PR-3, F26\)\.\n/m;
    // (a) red when the selector is dropped or stops reaching the drive path, or run-attach's use
    //     loses its reason (or the reason stops being what lets it pass); (b) prints the counts.
    expect({
      printSite: (await hits('packages/cli/src/agent/zz-lint-probe.ts', plain)).length,
      reasonPresent: reason.test(source),
      runAttach: (await hits(RUN_ATTACH, source)).length,
      runAttachWithoutReason: (await hits(RUN_ATTACH, source.replace(reason, ''))).length,
    }).toEqual({ printSite: 1, reasonPresent: true, runAttach: 0, runAttachWithoutReason: 1 });
  });
});
