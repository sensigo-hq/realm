// cacheability.ts — issue #600 caching PR 5 (C3.2–C3.6): the host. For each agent step of a definition
// it builds the request each adapter would send (`describeRequestLayout`), lets core measure and judge
// it (`describeCacheability`), and renders the `cache:` lines `realm workflow validate`, `register`
// and `watch` print, and validate's `--json` field. It reads the runner's economics file through
// `@sensigo/realm-mcp`'s one reader, uncached, and nothing else: no key, no environment, no model
// table. The floor is the runner's (its economics file) or the author's (`--floor`), never realm's.
import {
  cacheVerdict,
  describeCacheability,
  minCacheableTokensFor,
  type CacheabilityStep,
  type CacheNotJudgedCause,
  type CacheVerdict,
  type WorkflowDefinition,
} from '@sensigo/realm';
import {
  ANTHROPIC_TOOL_TEXT_TOKENS,
  describeRequestLayout,
  type Block,
  type RequestAdapter,
} from '../agent/providers/request-layout.js';
import { chooseAdapter, type ProviderName } from '../agent/providers/llm-provider.js';
import { quotedForTerminal } from './holder-render.js';

// ─── The flags ──────────────────────────────────────────────────────────────────────────────────

/** The four flags `validate`, `register` and `watch` take, checked. */
export interface CacheFlags {
  provider?: ProviderName;
  model?: string;
  floor?: number;
  ratio?: number;
}

/** The commander help of each flag, shared by the three commands. */
export const CACHE_FLAG_HELP = {
  provider:
    "The provider the runner uses, anthropic or openai: the cache lines then describe that provider's request alone",
  model:
    'The model the runner uses (needs --provider): its minimum is read from your economics file (runner.cache.economics)',
  floor: "A minimum to judge each agent step against, in tokens (the author's own test)",
  ratio:
    'Characters per token from your own count of one step, in place of the default 2.5–5 range',
} as const;

/**
 * Checks the flags before anything else runs (validate's usage-error precedent: stderr, human even
 * under `--json`, exit 1). The first refusal is the `NO_DEFAULT_MODEL` family's (`llm-provider.ts`:
 * realm has no default model, and does not guess a model's provider either); that const is private
 * there, so its first sentence is restated here in the same family.
 */
export function checkCacheFlags(opts: {
  provider?: ProviderName;
  model?: string;
  floor?: string;
  ratio?: string;
}): { ok: true; flags: CacheFlags } | { ok: false; message: string } {
  if (opts.model !== undefined && opts.provider === undefined) {
    return {
      ok: false,
      message:
        "Error: --provider is required with --model: realm does not guess a model's provider. Add --provider anthropic or --provider openai.",
    };
  }
  let floor: number | undefined;
  if (opts.floor !== undefined) {
    const n = Number(opts.floor);
    if (!/^\d+$/.test(opts.floor) || !Number.isSafeInteger(n) || n < 1) {
      return {
        ok: false,
        message: `Error: --floor must be a whole number of tokens, 1 or more (got '${opts.floor}').`,
      };
    }
    floor = n;
  }
  let ratio: number | undefined;
  if (opts.ratio !== undefined) {
    const r = Number(opts.ratio);
    if (!/^(\d+(\.\d*)?|\.\d+)$/.test(opts.ratio) || !(r > 0)) {
      return {
        ok: false,
        message: `Error: --ratio must be a number of characters per token above 0 (got '${opts.ratio}').`,
      };
    }
    ratio = r;
  }
  return {
    ok: true,
    flags: {
      ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(floor !== undefined ? { floor } : {}),
      ...(ratio !== undefined ? { ratio } : {}),
    },
  };
}

// ─── The report ─────────────────────────────────────────────────────────────────────────────────

/** Where the definition came from, as far as the cache lines need it. */
export interface CacheContext {
  /** The runner's economics file the admission load resolved (`runner.cache.economics`). */
  cacheEconomicsPath?: string;
  /** `--registered`: why agent-profile resolution did not run (the existing not-run reason). */
  profilesNotRun?: string;
  /** `--registered`: why the project-extensions check did not run — no economics path is known. */
  economicsNotRun?: string;
}

type Floor = { tokens: number; basis: 'flag' | 'economics'; economics_tokens?: number };

/** What the economics file says of `--model`, or why it says nothing. */
type EconomicsAnswer =
  | { tokens: number }
  | {
      cause:
        | 'no_economics_file'
        | 'economics_unreachable'
        | 'economics_unreadable'
        | 'model_unknown'
        | 'no_minimum_stated';
      detail?: string;
    };

/** A sharing clause as printed: its kind, the shared length, and the steps, in definition order. */
interface ShareClause {
  kind: 'whole' | 'schemas';
  chars: number;
  steps: string[];
}

/** One step on one layout. */
interface LayoutResult {
  adapter: RequestAdapter;
  verdict: CacheVerdict;
  cause?: CacheNotJudgedCause;
  /** Present when the step is sized on this layout. */
  sized?: {
    step: CacheabilityStep;
    blocks: Block[];
    banded: boolean;
    noSchemaAnthropic: boolean;
    openaiStrictSchema: boolean;
    strictRung: boolean;
    clauses: ShareClause[];
  };
}

interface StepResult {
  step: string;
  kind: 'tools' | 'profile_unavailable' | 'sized';
  layouts: LayoutResult[];
  /** The clause after the sizes, for rows 5–11 (the same on every layout). */
  cause?: { cause: CacheNotJudgedCause; detail?: string };
}

/** What `realm workflow validate | register | watch` know of each agent step's fixed part. */
export interface CacheabilityReport {
  flags: CacheFlags;
  adapters: RequestAdapter[];
  floor?: Floor;
  steps: StepResult[];
  profilesNotRun?: string;
  economicsNotRun?: string;
}

/** The layouts the flags name: both built-in ones with no provider; the provider's own with one. */
function adaptersFor(flags: CacheFlags): RequestAdapter[] {
  if (flags.provider === undefined) return ['anthropic', 'openai'];
  return [chooseAdapter(flags.provider, flags.model ?? '')];
}

/** What the economics file says of the model, read once (uncached: watch reads it on each save). */
async function economicsFor(model: string, path: string | undefined): Promise<EconomicsAnswer> {
  if (path === undefined) return { cause: 'no_economics_file' };
  const { readCacheEconomics } = await import('@sensigo/realm-mcp');
  const read = await readCacheEconomics(path);
  if ('cause' in read) return { cause: read.cause, detail: read.detail };
  const min = minCacheableTokensFor(read.economics, model);
  return 'tokens' in min ? { tokens: min.tokens } : { cause: min.absent };
}

/**
 * Where a step's profile ends in its fixed text (the stable blocks in wire order, as core joins them),
 * its `\n\n` included; 0 when the step carries no profile text.
 */
function profileEnd(blocks: Block[]): number {
  let offset = 0;
  for (const block of blocks) {
    if (!block.stable) continue;
    const profile = block.segments.find((s) => s.name === 'profile');
    if (profile !== undefined) return profile.end - profile.start > 2 ? offset + profile.end : 0;
    offset += block.text.length;
  }
  return 0;
}

/**
 * The sharing a step's line names, grouped. A line names only a share that can produce a read (MA 2,
 * the design authority, 2026-10-27):
 * - nothing for a step whose verdict on this layout is below the floor: it writes no cache entry, so
 *   no share can produce a read (MA 2, 2026-10-28; correction 2, F-4). The one exception is a layout
 *   whose size realm does not count in full (`sizeCounted` false: OpenAI's strict rung, where the
 *   provider adds its own schema text): there `below` does not rule a read out, and the clauses stay;
 * - otherwise, a whole shared fixed part, on every layout;
 * - on Anthropic nothing else: Anthropic writes its cache entry only at the marked block, and a read
 *   needs every byte up to and including it, so a pair that parts earlier shares no entry;
 * - on OpenAI, a pair that parts in a schema after the whole of a profile both steps carry: the
 *   author's own text, which leads the system prompt. Realm's own text alone is never named, and the
 *   strict rung, whose schema comes first, never shares a whole profile. With a floor in force, such
 *   a pair is named only when its shared start's estimate reaches the floor or comes near it:
 *   OpenAI's cache matches a prefix only past its minimum (C-7). With no floor, Realm, which ships no
 *   minimum, cannot judge the length, and the line states a fact about the text.
 * `ends` holds each step's `profileEnd` on this layout; `floor` is the floor in force, in tokens;
 * `sizeCounted` is false when realm does not count the whole fixed part (OpenAI's strict rung).
 * Exported for its cells (correction 2, F-9), which pin each condition with a hand-built step; it is
 * internal to the CLI package, not a public interface.
 */
export function shareClauses(
  step: CacheabilityStep,
  adapter: RequestAdapter,
  ends: Map<string, number>,
  floor: number | undefined,
  sizeCounted: boolean,
): ShareClause[] {
  if (step.verdict === 'below_floor' && sizeCounted) return [];
  const own = ends.get(step.step) ?? 0;
  const groups = new Map<string, ShareClause>();
  for (const share of step.shares_with) {
    let kind: ShareClause['kind'] | undefined;
    if (share.divergence_at === null) kind = 'whole';
    else if (
      isOpenAi(adapter) &&
      own > 0 &&
      ends.get(share.step) === own &&
      share.chars >= own &&
      share.divergence_at === 'schema_line' &&
      (floor === undefined || cacheVerdict(share.tokens, floor) !== 'below_floor')
    )
      kind = 'schemas';
    if (kind === undefined) continue;
    const key = `${kind}:${kind === 'whole' ? 0 : share.chars}`;
    const group = groups.get(key);
    if (group !== undefined) group.steps.push(share.step);
    else groups.set(key, { kind, chars: share.chars, steps: [share.step] });
  }
  return [...groups.values()].sort((a, b) =>
    a.kind === 'whole' || b.kind === 'whole'
      ? (a.kind === 'whole' ? 0 : 1) - (b.kind === 'whole' ? 0 : 1)
      : b.chars - a.chars,
  );
}

/**
 * Builds the report: for each agent step, the first row of the decision table that applies decides
 * its clause on every layout (C3.2). Rows 1 and 2 are the step's own; rows 3–12 are the flags' and
 * the economics file's, the same for every step.
 */
export async function buildCacheabilityReport(
  definition: WorkflowDefinition,
  flags: CacheFlags,
  ctx: CacheContext = {},
): Promise<CacheabilityReport> {
  const adapters = adaptersFor(flags);
  const economics =
    flags.model !== undefined && ctx.economicsNotRun === undefined
      ? await economicsFor(flags.model, ctx.cacheEconomicsPath)
      : undefined;
  const fromFile = economics !== undefined && 'tokens' in economics ? economics.tokens : undefined;
  let floor: Floor | undefined;
  if (flags.floor !== undefined) {
    floor = {
      tokens: flags.floor,
      basis: 'flag',
      ...(fromFile !== undefined && fromFile !== flags.floor ? { economics_tokens: fromFile } : {}),
    };
  } else if (fromFile !== undefined) {
    floor = { tokens: fromFile, basis: 'economics' };
  }
  // Rows 5–12: the clause after the sizes when no floor applies.
  let cause: StepResult['cause'];
  if (floor === undefined) {
    if (ctx.economicsNotRun !== undefined) cause = { cause: 'economics_not_checked' };
    else if (economics !== undefined && 'cause' in economics)
      cause = {
        cause: economics.cause,
        ...(economics.detail !== undefined ? { detail: economics.detail } : {}),
      };
    else cause = { cause: 'no_model' };
  }

  const agentSteps = Object.entries(definition.steps).filter(([, s]) => s.execution === 'agent');
  const results: StepResult[] = agentSteps.map(([name, step]) => {
    if (step.tools !== undefined && step.tools.length > 0) {
      return {
        step: name,
        kind: 'tools',
        layouts: adapters.map((adapter) => ({
          adapter,
          verdict: 'not_judged',
          cause: 'tools_step',
        })),
      };
    }
    if (ctx.profilesNotRun !== undefined && step.agent_profile !== undefined) {
      return {
        step: name,
        kind: 'profile_unavailable',
        layouts: adapters.map((adapter) => ({
          adapter,
          verdict: 'not_judged',
          cause: 'profile_unavailable',
        })),
      };
    }
    return { step: name, kind: 'sized', layouts: [], ...(cause !== undefined ? { cause } : {}) };
  });

  for (const adapter of adapters) {
    const sized = agentSteps.filter((_, i) => results[i]!.kind === 'sized');
    const inputs = sized.map(([name, step]) => {
      const schema = (step.output_schema ?? step.input_schema) as
        Record<string, unknown> | undefined;
      const profile =
        step.agent_profile !== undefined
          ? definition.resolved_profiles?.[step.agent_profile]?.content
          : undefined;
      const strict = step.structured_output === 'strict';
      const blocks = describeRequestLayout(adapter, {
        ...(profile !== undefined ? { profile } : {}),
        ...(schema !== undefined ? { schema } : {}),
        strict,
      });
      const banded =
        adapter === 'anthropic' &&
        flags.ratio === undefined &&
        blocks.some((b) => b.name === 'tools');
      return {
        name,
        blocks,
        banded,
        noSchemaAnthropic: adapter === 'anthropic' && schema === undefined,
        openaiStrictSchema: blocks.some((b) => b.name === 'response_format'),
        strictRung: strict && schema !== undefined && adapter !== 'openai-reasoning',
      };
    });
    const measured = describeCacheability(
      inputs.map((input) => ({
        step: input.name,
        blocks: input.blocks,
        ...(input.banded ? { extraTokens: { ...ANTHROPIC_TOOL_TEXT_TOKENS } } : {}),
      })),
      {
        ...(floor !== undefined ? { floor: { tokens: floor.tokens } } : {}),
        ...(flags.ratio !== undefined ? { ratio: { chars_per_token: flags.ratio } } : {}),
      },
    );
    const ends = new Map(inputs.map((input) => [input.name, profileEnd(input.blocks)]));
    inputs.forEach((input, k) => {
      const result = results.find((r) => r.step === input.name)!;
      const step = measured[k]!;
      const verdict: CacheVerdict = floor !== undefined ? step.verdict : 'not_judged';
      const layoutCause: CacheNotJudgedCause | undefined =
        verdict === 'near_floor'
          ? 'near_floor'
          : verdict === 'not_judged'
            ? (result.cause?.cause ?? 'no_model')
            : undefined;
      result.layouts.push({
        adapter,
        verdict,
        ...(layoutCause !== undefined ? { cause: layoutCause } : {}),
        sized: {
          step,
          blocks: input.blocks,
          banded: input.banded,
          noSchemaAnthropic: input.noSchemaAnthropic,
          openaiStrictSchema: input.openaiStrictSchema,
          strictRung: input.strictRung,
          clauses: shareClauses(step, adapter, ends, floor?.tokens, !input.openaiStrictSchema),
        },
      });
    });
  }

  return {
    flags,
    adapters,
    ...(floor !== undefined ? { floor } : {}),
    steps: results,
    ...(ctx.profilesNotRun !== undefined ? { profilesNotRun: ctx.profilesNotRun } : {}),
    ...(ctx.economicsNotRun !== undefined ? { economicsNotRun: ctx.economicsNotRun } : {}),
  };
}

// ─── The words (C3.4) ───────────────────────────────────────────────────────────────────────────

const NUMBER = new Intl.NumberFormat('en-US');
const n = (value: number): string => NUMBER.format(value);

/** A host's free text, escaped when it needs it — `realm run inspect`'s rule (its `safeText` is
 *  private to inspect.ts): the text as it is, or quoted when escaping would change it. */
function safeText(text: string): string {
  const quoted = quotedForTerminal(text);
  return quoted.slice(1, -1) === text ? text : quoted;
}

const isOpenAi = (adapter: RequestAdapter): boolean => adapter !== 'anthropic';

/** `<chars> chars ≈ <lo>–<hi> tokens[, with Anthropic's tool text]`. */
function sizeText(layout: LayoutResult): string {
  const s = layout.sized!;
  const t = s.step.prefix.tokens;
  return (
    `${n(s.step.prefix.chars)} chars ≈ ${n(t.low)}–${n(t.high)} tokens` +
    (s.banded ? ", with Anthropic's tool text" : '')
  );
}

const NO_SCHEMA = ' (no schema: realm sends no tool)';

function floorName(report: CacheabilityReport): string {
  return report.flags.model !== undefined ? `the floor for ${report.flags.model}` : 'the floor';
}

function basisText(floor: Floor): string {
  if (floor.basis === 'economics') return 'your economics file';
  return floor.economics_tokens !== undefined
    ? `your --floor; your economics file says ${n(floor.economics_tokens)}`
    : 'your --floor';
}

/** ` — <verdict> <floor> (<n>, <basis>)[: <tail>]`; `short` leaves near's tail out (two layouts). */
function verdictText(report: CacheabilityReport, layout: LayoutResult, short: boolean): string {
  const floor = report.floor!;
  const head = `${floorName(report)} (${n(floor.tokens)}, ${basisText(floor)})`;
  switch (layout.verdict) {
    case 'below_floor':
      // `on it` speaks for the model: only when the minimum is the one the runner's economics file
      // states for it; a minimum the author typed (`--floor`) is `that minimum` (correction 1, C-4).
      return (
        ` — below ${head}: ` +
        (floor.basis === 'economics'
          ? 'this step cannot cache on it'
          : 'this step cannot cache at that minimum') +
        (layout.sized?.openaiStrictSchema === true
          ? "; by realm's bytes — OpenAI's own schema text is not counted"
          : '')
      );
    case 'above_floor':
      // As `below`: `long enough to cache` speaks for the model only on the economics file's
      // minimum; on the author's `--floor` it is `at that minimum` (correction 2, F-5).
      return isOpenAi(layout.adapter)
        ? ` — above ${head}: within the provider's own rules (realm sends no marker)`
        : ` — above ${head}: long enough to cache ` +
            (floor.basis === 'economics' ? '' : 'at that minimum ') +
            'when the drive asks for caching';
    default:
      // The advice to pass --ratio only when it was not passed (correction 1, C-3).
      return short
        ? ` — near ${head}`
        : ` — near ${head}: not judged from an estimate` +
            (report.flags.ratio === undefined ? '; --ratio <chars-per-token> narrows it' : '');
  }
}

/** The clause rows 5–11 put after the sizes. */
function causeText(report: CacheabilityReport, cause: NonNullable<StepResult['cause']>): string {
  const model = report.flags.model ?? '';
  switch (cause.cause) {
    case 'no_economics_file':
      return ' — no economics file named in realm.yaml (runner.cache.economics); --floor tests a minimum';
    case 'economics_unreachable':
      return ` — economics unreachable: ${safeText(cause.detail ?? '')}`;
    case 'economics_unreadable':
      return ` — your economics file: ${safeText(cause.detail ?? '')}`;
    case 'model_unknown':
      return ` — no entry for ${model} in your economics file`;
    case 'no_minimum_stated':
      return ` — no minimum stated for ${model} in your economics file`;
    case 'economics_not_checked':
      return ` — economics not checked (${report.economicsNotRun ?? ''})`;
    default:
      // no_model: printed when a provider is named; the default two-layout line has no clause.
      return report.flags.provider !== undefined
        ? ' — the floor was not judged: no --model named'
        : '';
  }
}

/** The names a clause prints: all of six or fewer; of more, the first five and `and N more`. The
 *  cap is the rendering's only: the clause, and `--json`'s `shares_with`, keep every step. */
function namesText(steps: string[]): string {
  return steps.length <= 6
    ? steps.join(', ')
    : `${steps.slice(0, 5).join(', ')} and ${n(steps.length - 5)} more`;
}

function clauseText(clause: ShareClause): string {
  const steps = namesText(clause.steps);
  return clause.kind === 'whole'
    ? `shares its whole fixed part with ${steps}`
    : `shares its first ${n(clause.chars)} chars with ${steps}: the schemas differ`;
}

/** ` — <clauses>`, once when every layout says the same, else per layout; '' when none says any. */
function sharingText(layouts: LayoutResult[]): string {
  const per = layouts.map((l) => ({
    adapter: l.adapter,
    text: l.sized!.clauses.map(clauseText).join('; '),
  }));
  if (per.every((p) => p.text === per[0]!.text))
    return per[0]!.text !== '' ? ` — ${per[0]!.text}` : '';
  const shown = per.filter((p) => p.text !== '').map((p) => `${p.adapter}: ${p.text}`);
  return shown.length > 0 ? ` — ${shown.join(' · ')}` : '';
}

/** One step's line. */
function stepLine(report: CacheabilityReport, result: StepResult): string {
  if (result.kind === 'tools') {
    return `cache: ${result.step} — uses tools: each tool's definition comes from its MCP server at run time, so the request cannot be measured before a run: not judged`;
  }
  if (result.kind === 'profile_unavailable') {
    return `cache: ${result.step} — profile unavailable (${report.profilesNotRun ?? ''}): sizes not computed`;
  }
  const layouts = result.layouts;
  const ratio = report.flags.ratio;
  let body: string;
  if (layouts.length === 1) {
    const layout = layouts[0]!;
    body =
      sizeText(layout) +
      (ratio !== undefined
        ? ` (estimate: ${String(ratio)} chars/token ±15%, your --ratio)`
        : ' (estimate)') +
      (layout.sized!.noSchemaAnthropic ? NO_SCHEMA : '') +
      (report.floor !== undefined
        ? verdictText(report, layout, false)
        : result.cause !== undefined
          ? causeText(report, result.cause)
          : '');
  } else {
    const sizes = layouts.map(
      (l) => `${l.adapter} ${sizeText(l)}${l.sized!.noSchemaAnthropic ? NO_SCHEMA : ''}`,
    );
    if (report.floor !== undefined) {
      // The ratio the numbers come from closes the layouts, as on every other line (correction 1,
      // C-5).
      body =
        layouts.map((l, i) => `${sizes[i]!}${verdictText(report, l, true)}`).join(' · ') +
        (ratio !== undefined
          ? ` (estimates: ${String(ratio)} chars/token ±15%, your --ratio)`
          : '');
    } else {
      body =
        sizes.join(' · ') +
        (ratio !== undefined
          ? ` (estimates: ${String(ratio)} chars/token ±15%, your --ratio)`
          : ' (estimates: 2.5–5 chars/token, with margin)') +
        (result.cause !== undefined ? causeText(report, result.cause) : '');
    }
  }
  return `cache: ${result.step} — ${body}${sharingText(layouts)}`;
}

const ANTHROPIC_ONCE =
  "anthropic: on steps without tools, realm marks the fixed part for caching unless the drive's --prompt-cache turns it off; a fixed part below the model's minimum is sent uncached, silently";
const OPENAI_ONCE =
  "openai: realm sends no cache marker; the provider's own rules decide — see https://developers.openai.com/api/docs/guides/prompt-caching (as of 2026-10-16)";
const SCOPE_ONCE =
  "anthropic: the cache is kept per workspace (per organization on Bedrock and Google Cloud), as Anthropic's page said on 2026-10-09: drives from different workspaces each pay the write";

/**
 * The block's lines: one per agent step, in definition order, then the once-lines that are true for
 * it — each per-layout line only when some step line shows a size for that layout (Δ15). A
 * definition with no agent step has none.
 */
export function renderCacheabilityLines(report: CacheabilityReport): {
  steps: string[];
  once: string[];
} {
  const steps = report.steps.map((s) => stepLine(report, s));
  const shown = (pred: (a: RequestAdapter) => boolean): boolean =>
    report.steps.some((s) => s.layouts.some((l) => l.sized !== undefined && pred(l.adapter)));
  const anthropic = shown((a) => a === 'anthropic');
  const openai = shown(isOpenAi);
  return {
    steps,
    once: [
      ...(anthropic ? [ANTHROPIC_ONCE] : []),
      ...(openai ? [OPENAI_ONCE] : []),
      ...(anthropic ? [SCOPE_ONCE] : []),
    ],
  };
}

/** The once-lines this process has printed: each is printed once per process (watch prints many blocks). */
const printedOnce = new Set<string>();

/** Prints the block: its step lines, then each once-line this process has not printed yet. */
export function printCacheabilityLines(
  lines: { steps: string[]; once: string[] },
  prefix = '',
): void {
  for (const line of lines.steps) console.log(`${prefix}${line}`);
  for (const line of lines.once) {
    if (printedOnce.has(line)) continue;
    printedOnce.add(line);
    console.log(`${prefix}${line}`);
  }
}

// ─── `--json` (C3.6) ────────────────────────────────────────────────────────────────────────────

/** validate's `cacheability` field: sizes, counts, verdict and cause words, segment names, step
 *  ids, a model id and floor numbers — never prompt text. */
export function cacheabilityJson(report: CacheabilityReport): Record<string, unknown> {
  return {
    ...(report.flags.provider !== undefined ? { provider: report.flags.provider } : {}),
    ...(report.flags.model !== undefined ? { model: report.flags.model } : {}),
    ...(report.floor !== undefined ? { floor: report.floor } : {}),
    ...(report.flags.ratio !== undefined
      ? { ratio: { chars_per_token: report.flags.ratio, basis: 'flag' } }
      : {}),
    steps: report.steps.map((s) => ({
      step: s.step,
      layouts: s.layouts.map((l) => {
        const sized = l.sized;
        return {
          adapter: l.adapter,
          ...(sized !== undefined
            ? {
                prefix: sized.step.prefix,
                blocks: sized.blocks
                  .filter((b) => b.stable)
                  .map((b) => ({ name: b.name, chars: b.text.length, segments: b.segments })),
                shares_with: sized.step.shares_with.filter((w) =>
                  sized.clauses.some((c) => c.steps.includes(w.step)),
                ),
                ...(sized.banded
                  ? {
                      extra_tokens: {
                        low: ANTHROPIC_TOOL_TEXT_TOKENS.low,
                        high: ANTHROPIC_TOOL_TEXT_TOKENS.high,
                        source: 'anthropic_tool_text',
                      },
                    }
                  : {}),
                ...(sized.openaiStrictSchema ? { not_counted: 'provider_schema_text' } : {}),
                strict_rung: sized.strictRung,
              }
            : {}),
          verdict: l.verdict,
          ...(l.cause !== undefined ? { not_judged_cause: l.cause } : {}),
        };
      }),
    })),
  };
}
