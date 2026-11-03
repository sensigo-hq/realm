# Cache economics file

<!-- description: Reference for the economics file, the prices a runner pays: where realm.yaml names it, its format, how a model call is priced from it, and what Realm prints when it cannot be read. -->

Realm can put a figure in US dollars on each model call a run made. It works the figure out each time the run is read, by `realm run inspect` and by `get_run_state`. A run's record stores no money, and `realm run export` writes none. Realm ships no prices. A figure comes from one of two places, asked in this order:

1. The economics file: the prices you pay, in a file `realm.yaml` names.
2. The price list `@pydantic/genai-prices`, when it is installed beside Realm. It holds the prices providers publish.

A model the file names is priced from the file. Any other model is priced from the list. This page was added after version 0.47.0.

The outputs on this page came from `realm run inspect` on a run whose one step made 2 requests to `claude-sonnet-5-5`: the first wrote 1800 tokens to the cache, the second read them. The run record was written for these docs; no model was called.

## Where `realm.yaml` names it

```yaml
version: 1
runner:
  cache:
    economics: config/economics.yaml
```

`runner.cache.economics` is a path from the folder of `realm.yaml`, or a full path. A `${secret:…}` is not allowed here:

```text
runner.cache.economics: '${secret:X}' is not allowed here — secret references are legal only inside string values under 'config'.
```

Upgrade every realm that reads this folder before adding `runner:`. Older realms refuse the key.

The file is read once per process. Restart `realm serve` or `realm mcp` after editing it. `realm run inspect` is a new process each time, so it reads the file as it is.

Without the key, every model is priced from the list. The `realm-mcp` program reads no `realm.yaml`, so it prices from the list only.

## The format

```yaml
version: 1
currency: USD
models:
  claude-sonnet-5-5:
    prices:
      - per_million_tokens:
          input: 2
          output: 10
          cache_read: 0.1
          cache_write_5m: 2.5
          cache_write_1h: 4
```

These rates are an example: they are the entry for `claude-sonnet-5-5` in genai-prices 0.1.12, which writes them as:

```json
"prices": { "input_mtok": 2, "cache_write_mtok": 2.5, "cache_read_mtok": 0.1, "output_mtok": 10, "cache_write_1h_mtok": 4 }
```

| Key        | Required | Holds                                          |
| ---------- | -------- | ---------------------------------------------- |
| `version`  | Yes      | `1`.                                           |
| `currency` | Yes      | `USD`.                                         |
| `models`   | Yes      | One entry for each model, by the model's name. |

A model's entry has `prices`, and may carry `min_cacheable_tokens` (see [The cache minimum](#the-cache-minimum)). `prices` is a list of one or more prices. Each price has these keys:

| Key                  | Required                         | Holds                                                                                                              |
| -------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `start_date`         | Not on the first; on every other | The day the price applies from, `YYYY-MM-DD`, in UTC. The first price has none: it applies before every dated one. |
| `per_million_tokens` | Yes                              | The rates, in US dollars for one million tokens.                                                                   |
| `tiers`              | No                               | Rates for a long prompt. See below.                                                                                |

| Rate             | Required                                    | Prices                                                                                                                                                                                                                                                                                                                                      |
| ---------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input`          | Yes                                         | The prompt tokens that were neither read from the cache nor written to it.                                                                                                                                                                                                                                                                  |
| `output`         | Yes                                         | The output tokens.                                                                                                                                                                                                                                                                                                                          |
| `cache_read`     | When a request read from the cache          | The tokens read from the cache.                                                                                                                                                                                                                                                                                                             |
| `cache_write`    | When a request wrote with no lifetime split | The tokens written to the cache. OpenAI's page says (2026-10-28) that for GPT-5.6 and later a write has a 30-minute lifetime by default, or a 12-hour minimum lifetime at a higher write rate in the Responses API, and that OpenAI may keep entries longer than the requested minimum; the economics file has no key for the 12-hour rate. |
| `cache_write_5m` | When a request's writes were split          | The tokens kept for 5 minutes. Anthropic says which lifetime each write was kept for.                                                                                                                                                                                                                                                       |
| `cache_write_1h` | When a request's writes were split          | The tokens kept for 1 hour.                                                                                                                                                                                                                                                                                                                 |

Any other key is refused. A rate is a number, 0 or more.

A price with dates:

```yaml
models:
  my-model:
    prices:
      - per_million_tokens: { input: 6, output: 30 }
      - start_date: '2026-03-01'
        per_million_tokens: { input: 3, output: 15 }
```

A request that started before 1 March 2026, UTC, is priced at the first price. A request from that day on is priced at the second. A date without quotes is read the same way.

### Tiers

A tier prices a request whose prompt is long. When a request's prompt has more tokens than `above_prompt_tokens`, the whole request is priced at the tier's rates, its output too. A tier carries every rate its price has. An example, the entry for `claude-haiku-5-5` in genai-prices 0.1.12:

```yaml
models:
  claude-haiku-5-5:
    prices:
      - per_million_tokens:
          input: 0.1
          output: 0.5
          cache_read: 0.01
          cache_write_5m: 0.125
          cache_write_1h: 0.2
        tiers:
          - above_prompt_tokens: 100000
            per_million_tokens:
              input: 0.5
              output: 2.5
              cache_read: 0.05
              cache_write_5m: 0.625
              cache_write_1h: 1
```

A request with a prompt of 100,000 tokens is priced at the first rates. One with 100,001 is priced at the tier's.

## The cache minimum

A model's entry may also carry `min_cacheable_tokens`: the fewest input tokens the provider caches for that model. `realm workflow validate`, `register` and `watch` read it when given `--provider` and `--model`, and say of each agent step whether its fixed part is long enough to be cached: see [the cache lines](cli/realm-workflow.md#the-cache-lines). Pricing does not read it. This key was added after version 0.48.0.

```yaml
models:
  claude-sonnet-5-5:
    min_cacheable_tokens: 512
    prices:
      - per_million_tokens:
          { input: 2, output: 10, cache_read: 0.1, cache_write_5m: 2.5, cache_write_1h: 4 }
```

It is a whole number, 1 or more. A model name with a date at its end finds the same entry for its minimum as for its price.

**Upgrade every realm that reads the folder before adding the key.** A realm older than this release refuses a file carrying it, on every run's price line, with `your economics file: '<path>': economics/models/<id>: unknown key 'min_cacheable_tokens'`.

The minimums the providers published, as of 2026-10-16. Copy the table of the platform you call: Bedrock's differs from Anthropic's on Opus 4.7. For an OpenAI model before GPT-5.6, state no minimum: OpenAI says it varies with the request's settings.

| Platform                                                                                                     | Minimum | Models                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)                            | 512     | Fable 5.1, Mythos 5.1, Opus 5.5, Opus 5, Sonnet 5.5, Haiku 5.5, Fable 5, Mythos 5                                                         |
|                                                                                                              | 1,024   | Opus 4.8, Sonnet 5, Sonnet 4.6, Sonnet 4.5 (the page lists more)                                                                          |
|                                                                                                              | 2,048   | Mythos Preview, Opus 4.7                                                                                                                  |
|                                                                                                              | 4,096   | Opus 4.6, Opus 4.5, Haiku 4.5                                                                                                             |
| [Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html), as of 2026-10-27 | 512     | Haiku 5.5, Sonnet 5.5, Opus 5.5, Fable 5.1, Mythos 5.1, Fable 5, Mythos 5, Opus 5                                                         |
|                                                                                                              | 1,024   | Opus 4.8, Sonnet 5, Sonnet 4.6, Sonnet 4.5, 3.7 Sonnet, 3.5 Sonnet v2, GPT-6.1 Sol, GPT-6 Astra, GPT-5.6 Sol, GPT-5.6 Terra, GPT-5.6 Luna |
|                                                                                                              | 4,096   | Opus 4.7, Opus 4.6, Opus 4.5, Haiku 4.5                                                                                                   |
| [Google Gemini](https://ai.google.dev/gemini-api/docs/caching)                                               | 2,048   | Gemini 2.5 Flash, Gemini 2.5 Pro                                                                                                          |
|                                                                                                              | 4,096   | Gemini 4 Argon, 3.8 Flash, 3.6 Flash, 3.1 Pro Preview                                                                                     |
| [OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching)                                       | 1,024   | GPT-5.6 and later                                                                                                                         |

## How a request is priced

Each request is priced on its own, so a tier depends on that request's own prompt.

1. The model: the price whose name is the model the provider's answer named. When there is none, the name without a date at its end (`-20260101` or `-2026-01-01`, a day on the calendar): `claude-sonnet-5-5-20260101` is priced as `claude-sonnet-5-5`.
2. The price: the last one whose `start_date` is on or before the day the request started. When none is, the first.
3. The tokens: the prompt, less what was read from the cache, less what was written to it, at `input`; what was read at `cache_read`; what was written at `cache_write_5m` and `cache_write_1h` when the provider split it, or at `cache_write`; the output at `output`.

Realm also prices the request as if nothing had been cached: the whole prompt at `input` and the output at `output`, at the same tier. The difference is what caching saved, or what it cost.

A model with one price prints `current price`. A model with several prices prints `at the call's date`. A figure over both kinds says how many of each: `1 at the call's date, 1 current`.

## What `--prompt-cache auto` reads from it

On a drive `realm listen` starts with Anthropic, `--prompt-cache auto` chooses which cache lifetime to ask for from the gaps between the workflow's recent triggers, priced from this file. This section was added after version 0.48.0.

- `realm agent` reads the file once, when the drive starts, after the workflow and `realm.yaml` load. A drive with no measured gap reads no file: a drive `realm agent` starts on its own, and a workflow's first trigger since `realm listen` started. So do `--prompt-cache short`, `long` and `off`, OpenAI and a provider module.
- The choice reads the entry of the id you pass to `--model`, as a request is priced: that id, else the id without a date at its end. Key your price file by the id you pass to `--model`: an entry keyed only by a dated id does not match an undated `--model`.
- The choice reads the price row in force when the drive starts, on the base tier: the price's own rates, never a tier's.
- Each rate is divided by `input`. 5 minutes is costed only when the row states `cache_read` and `cache_write_5m`, and 1 hour only when it states `cache_read` and `cache_write_1h`. A lifetime the row cannot cost is never chosen, no rate is filled from another, and a single `cache_write` is not read as either lifetime's write.
- Over the last five gaps, a lifetime costs `cache_read` for a gap under 90% of it, else its write rate; no caching costs `input`. `auto` asks for the cheapest; on a tie, the longer lifetime.
- When the file cannot price the choice — `runner.cache.economics` is not set, the file cannot be read or is not a valid price file, it has no entry for the model, it prices `input` at 0, or it has no `cache_read` or no write rate for either lifetime — `auto` asks for 1 hour when any of the last five gaps is under 54 minutes, and for no caching otherwise.
- `auto` reads only this file, never the installed price list. Realm ships no prices, for the choice either.
- The drive's `Caching:` line, `realm run inspect`, `get_run_state` and each request's record (`cache_auto.prices`) say whether the choice was priced from your file, and why not when it was not.
- The file decides which lifetime `auto` asks for, so a login that can change it can change that choice. The separation check's economics line shows whether this login can.

## What Realm prints

From `realm run inspect`, at the end of the step's `Diagnostics` line:

```text
| $0.00575 (your economics file; current price); caching saved $0.00252
```

And after the run's `Phase:` line:

```text
Cost: $0.00575 (your economics file; current price; 2 of 2 requests priced); caching saved $0.00252
```

Without the key, with the list installed:

```text
Cost: $0.00575 (genai-prices 0.1.12; current price; 2 of 2 requests priced); caching saved $0.00252
```

When a request cannot be priced, the figure says why, and a `≥` says the figure leaves something out:

| The file                     | What `realm run inspect` prints                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cannot be read               | `not priced (economics unreachable: cannot read '/srv/shop/config/prices.yaml': ENOENT)`                                                                      |
| Is not valid                 | `not priced (your economics file: '/srv/shop/economics.yaml': economics/version: must be equal to constant)`                                                  |
| Lacks a rate a request needs | `≥ $0.00496 (your economics file; current price; 1 of 2 requests priced; 1 not priced: your economics file has no 'cache_read' rate for 'claude-sonnet-5-5')` |
| Is not named, and no list    | `not priced (no price source: add prices in runner.cache.economics, or install @pydantic/genai-prices beside realm)`                                          |
| Lacks the model, and no list | `not priced (no price for this model: add it to your economics file)`                                                                                         |

A file that is not valid prices nothing, so no figure mixes your prices with the list's. The reasons it is refused:

| The file                                                | Reason                                                                                                                            |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Has another key                                         | `economics: unknown key 'extra'`                                                                                                  |
| Has `version: 2`                                        | `economics/version: must be equal to constant`                                                                                    |
| Has `currency: EUR`                                     | `economics/currency: must be equal to one of the allowed values`                                                                  |
| Gives the first price a date                            | `economics/models/m/prices/0: the first price has no start_date (it applies before every dated one)`                              |
| Gives a later price no date                             | `economics/models/m/prices/1: every price after the first needs a start_date`                                                     |
| Has a date that is not on the calendar                  | `economics/models/m/prices/1: start_date '2026-02-30' is not a date on the calendar`                                              |
| Has dates out of order, or one twice                    | `economics/models/m/prices/2: start_date '2026-02-01' must come after '2026-03-01' (dates ascending, each once)`                  |
| Has a rate below 0                                      | `economics/models/m/prices/0/per_million_tokens/input: must be >= 0`                                                              |
| Has `min_cacheable_tokens: 0`                           | `economics/models/m/min_cacheable_tokens: must be >= 1`                                                                           |
| Has a `min_cacheable_tokens` that is not a whole number | `economics/models/m/min_cacheable_tokens: must be integer`                                                                        |
| Has tiers out of order, or one twice                    | `economics/models/m/prices/0/tiers/1: above_prompt_tokens must be above 200 (thresholds ascending, each once)`                    |
| Has a tier without a rate its price has                 | `economics/models/m/prices/0/tiers/0: the tier has no 'cache_read', which its price has (a tier carries every rate of its price)` |
| Is not YAML                                             | The YAML error, with its line and column.                                                                                         |

A figure from the list adds `list price, your endpoint may bill differently` when the request went to an endpoint other than the provider's own, such as one set with `--base-url`. On `get_run_state`, the same figures are unrounded numbers: see [Run state and health findings](mcp/run-state-and-health.md). On the step line, see [`realm run`: commands that read](cli/realm-run-reading.md#inspect).
