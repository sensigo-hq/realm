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

A model's entry has one key, `prices`: a list of one or more prices. Each price has these keys:

| Key                  | Required                         | Holds                                                                                                              |
| -------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `start_date`         | Not on the first; on every other | The day the price applies from, `YYYY-MM-DD`, in UTC. The first price has none: it applies before every dated one. |
| `per_million_tokens` | Yes                              | The rates, in US dollars for one million tokens.                                                                   |
| `tiers`              | No                               | Rates for a long prompt. See below.                                                                                |

| Rate             | Required                                    | Prices                                                                                |
| ---------------- | ------------------------------------------- | ------------------------------------------------------------------------------------- |
| `input`          | Yes                                         | The prompt tokens that were neither read from the cache nor written to it.            |
| `output`         | Yes                                         | The output tokens.                                                                    |
| `cache_read`     | When a request read from the cache          | The tokens read from the cache.                                                       |
| `cache_write`    | When a request wrote with no lifetime split | The tokens written to the cache. OpenAI does not say how long it keeps them.          |
| `cache_write_5m` | When a request's writes were split          | The tokens kept for 5 minutes. Anthropic says which lifetime each write was kept for. |
| `cache_write_1h` | When a request's writes were split          | The tokens kept for 1 hour.                                                           |

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

## How a request is priced

Each request is priced on its own, so a tier depends on that request's own prompt.

1. The model: the price whose name is the model the provider's answer named. When there is none, the name without a date at its end (`-20260101` or `-2026-01-01`): `claude-sonnet-5-5-20260101` is priced as `claude-sonnet-5-5`.
2. The price: the last one whose `start_date` is on or before the day the request started. When none is, the first.
3. The tokens: the prompt, less what was read from the cache, less what was written to it, at `input`; what was read at `cache_read`; what was written at `cache_write_5m` and `cache_write_1h` when the provider split it, or at `cache_write`; the output at `output`.

Realm also prices the request as if nothing had been cached: the whole prompt at `input` and the output at `output`, at the same tier. The difference is what caching saved, or what it cost.

A model with one price prints `current price`. A model with several prices prints `at the call's date`. A figure over both kinds says how many of each: `1 at the call's date, 1 current`.

## What Realm prints

From `realm run inspect`, at the end of the step's `Diagnostics` line:

```text
| $0.00575 (your economics file; current price); caching saved $0.00252
```

And after the run's `Phase:` line:

```text
Cost: $0.00575 (your economics file; 2 of 2 requests priced)
```

Without the key, with the list installed:

```text
Cost: $0.00575 (genai-prices 0.1.12; 2 of 2 requests priced)
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

| The file                                | Reason                                                                                                                            |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Has another key                         | `economics: unknown key 'extra'`                                                                                                  |
| Has `version: 2`                        | `economics/version: must be equal to constant`                                                                                    |
| Has `currency: EUR`                     | `economics/currency: must be equal to one of the allowed values`                                                                  |
| Gives the first price a date            | `economics/models/m/prices/0: the first price has no start_date (it applies before every dated one)`                              |
| Gives a later price no date             | `economics/models/m/prices/1: every price after the first needs a start_date`                                                     |
| Has a date that is not on the calendar  | `economics/models/m/prices/1: start_date '2026-02-30' is not a date on the calendar`                                              |
| Has dates out of order, or one twice    | `economics/models/m/prices/2: start_date '2026-02-01' must come after '2026-03-01' (dates ascending, each once)`                  |
| Has a rate below 0                      | `economics/models/m/prices/0/per_million_tokens/input: must be >= 0`                                                              |
| Has tiers out of order, or one twice    | `economics/models/m/prices/0/tiers/1: above_prompt_tokens must be above 200 (thresholds ascending, each once)`                    |
| Has a tier without a rate its price has | `economics/models/m/prices/0/tiers/0: the tier has no 'cache_read', which its price has (a tier carries every rate of its price)` |
| Is not YAML                             | The YAML error, with its line and column.                                                                                         |

A figure from the list adds `list price, your endpoint may bill differently` when the request went to an endpoint other than the provider's own, such as one set with `--base-url`. On `get_run_state`, the same figures are unrounded numbers: see [Run state and health findings](mcp/run-state-and-health.md). On the step line, see [`realm run`: commands that read](cli/realm-run-reading.md#inspect).
