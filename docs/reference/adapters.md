> **One auth channel (v0.14): construction.** Adapters receive credentials in their
> constructor config, bound in the deployment manifest ([realm.yaml](deployment-manifest.md))
> via `${secret:NAME}` references. Per-step `config` never carries auth, and the engine
> injects none (`auth.token_from` is gone). The `slack` ADAPTER (workflow steps posting
> to Slack) and the `slack_gate` NOTIFIER (gate approvals) are configured separately.

# Built-in Service Adapters

Reference documentation for the service adapters shipped with `@sensigo/realm`. Each
adapter implements `ServiceAdapter` and can be registered with `ExtensionRegistry`.
The `SlackAdapter` is documented in [Slack Gate Modes](realm-agent-slack.md).

---

## FileSystemAdapter

Reads files from the local filesystem. Pre-registered as `filesystem` by `createDefaultRegistry`
— no setup required for workflows that only need local files.

### YAML declaration

```yaml
services:
  source:
    adapter: filesystem
    trust: engine_delivered

steps:
  fetch_document:
    execution: auto
    uses_service: source
    operation: read
    input_map:
      path: run.params.file_path
```

### Operations

#### `fetch / read`

Reads a UTF-8 file and returns its content and metadata.

| Parameter | Type   | Required | Description                |
| --------- | ------ | -------- | -------------------------- |
| `path`    | string | Yes      | Absolute path to the file. |

**Response:**

| Field        | Type   | Description                        |
| ------------ | ------ | ---------------------------------- |
| `content`    | string | Full UTF-8 file content.           |
| `path`       | string | The path that was read.            |
| `line_count` | number | Number of newline-delimited lines. |
| `size_bytes` | number | File size in bytes.                |

**Errors:**

| Condition              | Error code                | `agent_action`  |
| ---------------------- | ------------------------- | --------------- |
| `path` is not absolute | `VALIDATION_INPUT_SCHEMA` | `provide_input` |
| File does not exist    | `RESOURCE_FETCH_FAILED`   | `provide_input` |
| Other read error       | `ENGINE_ADAPTER_FAILED`   | `stop`          |

---

## GitHubAdapter

Communicates with the GitHub REST API (or a GitHub Enterprise Server instance).

### Registration

**`realm agent` (CLI):** The CLI auto-registers `GitHubAdapter` under the name `github` when
`GITHUB_TOKEN` is set in the environment. No TypeScript registration code is needed.

```bash
export GITHUB_TOKEN=ghp_...
realm agent --workflow workflow.yaml --params '{"repo":"owner/repo","pr_number":42}'
```

**MCP server (programmatic):** Register the adapter explicitly before starting the server.

```typescript
import { GitHubAdapter, ExtensionRegistry } from '@sensigo/realm';
import { createRealmMcpServer } from '@sensigo/realm-mcp';

const registry = new ExtensionRegistry();
registry.register(
  'adapter',
  'github',
  new GitHubAdapter('github', { auth: { token: process.env['GITHUB_TOKEN'] } }),
);

const server = createRealmMcpServer({ registry });
server.start();
```

### YAML declaration

```yaml
services:
  github:
    adapter: github
    trust: engine_delivered
    auth:
      token_from: secrets.GITHUB_TOKEN
    config:
      base_url: 'https://api.github.com'
```

`config.base_url` defaults to `https://api.github.com`. Override it to point at a GitHub
Enterprise Server instance — for example `https://github.example.com/api/v3`.

### Authentication

Set `GITHUB_TOKEN` to a GitHub personal access token or fine-grained token with the
following scopes:

| Operation                  | Required scope                            |
| -------------------------- | ----------------------------------------- |
| Read-only on public repos  | No token required                         |
| Read-only on private repos | `repo` (classic) or `contents:read`       |
| `post_comment`             | `repo` (classic) or `issues:write`        |
| `apply_labels`             | `repo` (classic) or `issues:write`        |
| `set_pr_description`       | `repo` (classic) or `pull_requests:write` |

> Private repositories return HTTP 404 — not 403 — when the token lacks access.
> The adapter surfaces this with an actionable error that includes a `gh` CLI verification command.

### Operations — fetch (`service_method: fetch`)

#### `get_pr_diff`

Fetches the file diff and metadata for a pull request.

| Parameter   | Type   | Required | Description                        |
| ----------- | ------ | -------- | ---------------------------------- |
| `repo`      | string | Yes      | Repository in `owner/repo` format. |
| `pr_number` | number | Yes      | Pull request number.               |

**Response:**

| Field           | Type     | Description                                  |
| --------------- | -------- | -------------------------------------------- |
| `diff_text`     | string   | Unified diff — one section per changed file. |
| `pr_title`      | string   | Pull request title.                          |
| `base_branch`   | string   | Target branch name (e.g. `main`).            |
| `head_sha`      | string   | SHA of the head commit.                      |
| `files_changed` | string[] | List of changed file paths.                  |
| `repo`          | string   | Repository name, echoed from input.          |

**YAML step example:**

```yaml
fetch_pr:
  description: Fetch the pull request diff from GitHub.
  execution: auto
  depends_on: []
  uses_service: github
  service_method: fetch
  operation: get_pr_diff
  input_map:
    repo: run.params.repo
    pr_number: run.params.pr_number
```

---

#### `get_issue`

Fetches a single issue.

| Parameter      | Type   | Required | Description                        |
| -------------- | ------ | -------- | ---------------------------------- |
| `repo`         | string | Yes      | Repository in `owner/repo` format. |
| `issue_number` | number | Yes      | Issue number.                      |

**Response:** Raw GitHub issue object. Key fields: `title`, `body`, `state`, `labels`, `user.login`.

---

#### `get_issue_comments`

Fetches all comments on an issue.

| Parameter      | Type   | Required | Description                        |
| -------------- | ------ | -------- | ---------------------------------- |
| `repo`         | string | Yes      | Repository in `owner/repo` format. |
| `issue_number` | number | Yes      | Issue number.                      |

**Response:** Array of comment objects, each containing:

| Field        | Type   | Description                       |
| ------------ | ------ | --------------------------------- |
| `author`     | string | GitHub username of the commenter. |
| `body`       | string | Comment text.                     |
| `created_at` | string | ISO 8601 creation timestamp.      |

---

#### `get_linked_issues`

Lists issues linked to a pull request.

| Parameter   | Type   | Required | Description                        |
| ----------- | ------ | -------- | ---------------------------------- |
| `repo`      | string | Yes      | Repository in `owner/repo` format. |
| `pr_number` | number | Yes      | Pull request number.               |

**Response:** Raw GitHub issues array.

---

#### `get_file_contents`

Reads a file from a repository at an optional ref.

| Parameter | Type   | Required | Description                                                 |
| --------- | ------ | -------- | ----------------------------------------------------------- |
| `repo`    | string | Yes      | Repository in `owner/repo` format.                          |
| `path`    | string | Yes      | File path relative to the repository root.                  |
| `ref`     | string | No       | Commit SHA, branch, or tag. Defaults to the default branch. |

**Response:**

| Field     | Type   | Description                   |
| --------- | ------ | ----------------------------- |
| `path`    | string | File path, echoed from input. |
| `content` | string | UTF-8 decoded file content.   |

---

#### `get_pr_review_comments`

Fetches inline review comments on a pull request (code comments, not general PR comments).

| Parameter   | Type   | Required | Description                        |
| ----------- | ------ | -------- | ---------------------------------- |
| `repo`      | string | Yes      | Repository in `owner/repo` format. |
| `pr_number` | number | Yes      | Pull request number.               |

**Response:** Array of review comment objects, each containing:

| Field    | Type   | Description                         |
| -------- | ------ | ----------------------------------- |
| `file`   | string | Path of the file the comment is on. |
| `line`   | number | Line number in the file.            |
| `author` | string | GitHub username of the reviewer.    |
| `body`   | string | Comment text.                       |

---

### Operations — create (`service_method: create`)

#### `post_comment`

Posts a comment on an issue or pull request. Accepts either `issue_number` or `pr_number` —
GitHub's Issues API handles both identically.

| Parameter                    | Type   | Required     | Description                        |
| ---------------------------- | ------ | ------------ | ---------------------------------- |
| `repo`                       | string | Yes          | Repository in `owner/repo` format. |
| `issue_number` / `pr_number` | number | One required | Issue or PR number.                |
| `body`                       | string | Yes          | Comment text (Markdown supported). |

**Response:** Raw GitHub comment object (HTTP 201).

**YAML step example:**

```yaml
post_review_comment:
  description: Post the review comment to the pull request.
  execution: auto
  depends_on: [confirm_review]
  uses_service: github
  service_method: create
  operation: post_comment
  input_map:
    repo: run.params.repo
    pr_number: run.params.pr_number
    body: context.resources.write_review.review_comment
```

---

#### `apply_labels`

Applies one or more labels to an issue or pull request. Labels must already exist in the
repository — this operation does not create them.

| Parameter                    | Type     | Required     | Description                        |
| ---------------------------- | -------- | ------------ | ---------------------------------- |
| `repo`                       | string   | Yes          | Repository in `owner/repo` format. |
| `issue_number` / `pr_number` | number   | One required | Issue or PR number.                |
| `labels`                     | string[] | Yes          | Label names to apply.              |

**Response:** Raw GitHub labels array (HTTP 200).

---

### Operations — update (`service_method: update`)

#### `set_pr_description`

Updates the body (description) of a pull request.

| Parameter   | Type   | Required | Description                        |
| ----------- | ------ | -------- | ---------------------------------- |
| `repo`      | string | Yes      | Repository in `owner/repo` format. |
| `pr_number` | number | Yes      | Pull request number.               |
| `body`      | string | Yes      | New description text.              |

**Response:**

| Field  | Type    | Description                                  |
| ------ | ------- | -------------------------------------------- |
| `ok`   | boolean | Always `true` on success.                    |
| `body` | string  | The updated description as stored by GitHub. |

---

### Errors

| Condition                      | Error code              | `agent_action`   | Retryable |
| ------------------------------ | ----------------------- | ---------------- | --------- |
| Resource not found (HTTP 404)  | `SERVICE_HTTP_4XX`      | `stop`           | No        |
| Other client error (HTTP 4xx)  | `SERVICE_HTTP_4XX`      | `stop`           | No        |
| Server error (HTTP 5xx)        | `SERVICE_HTTP_5XX`      | `report_to_user` | Yes       |
| Network unreachable            | `NETWORK_UNREACHABLE`   | `wait_for_human` | Yes       |
| Request aborted (step timeout) | `STEP_ABORTED`          | `report_to_user` | No        |
| Unknown operation              | `ENGINE_ADAPTER_FAILED` | `stop`           | No        |

**404 diagnostics:** when a PR or issue fetch returns 404, the adapter enriches the error
with an actionable message including a `gh` CLI command to verify the resource exists and the
token has access. Private repository 404s are indistinguishable from "does not exist" at the
API level — the diagnostic message explains both cases.

---

## GenericHttpAdapter

Calls any REST API over HTTP/HTTPS. Not pre-registered — construct and register it for each
target service.

### Constructor config

```typescript
import { GenericHttpAdapter, ExtensionRegistry } from '@sensigo/realm';

const registry = new ExtensionRegistry();
registry.register(
  'adapter',
  'internal_api',
  new GenericHttpAdapter('internal_api', {
    base_url: 'https://api.example.com/v1',
    headers: { 'X-Client': 'realm' },
    auth: {
      type: 'bearer',
      token: process.env['INTERNAL_API_TOKEN'],
    },
  }),
);
```

| Config field       | Type                            | Required | Description                                                             |
| ------------------ | ------------------------------- | -------- | ----------------------------------------------------------------------- |
| `base_url`         | string                          | Yes      | Base URL for all requests.                                              |
| `headers`          | `Record<string, string>`        | No       | Static headers sent with every request.                                 |
| `auth.type`        | `bearer` \| `basic` \| `header` | No       | Authentication scheme.                                                  |
| `auth.token`       | string                          | No       | Token value (used by `bearer`, `basic`, `header`).                      |
| `auth.header_name` | string                          | No       | Custom header name for `auth.type: header`. Defaults to `X-Auth-Token`. |

### Authentication schemes

| `auth.type` | Header sent                            |
| ----------- | -------------------------------------- |
| `bearer`    | `Authorization: Bearer {token}`        |
| `basic`     | `Authorization: Basic {base64(token)}` |
| `header`    | `{header_name}: {token}`               |

`base_url` and `auth` are constructor-time configuration — they cannot be overridden per call.
Per-call headers can be passed in the YAML `config:` block under `headers`.

### Method mapping

| YAML `service_method` | HTTP method | URL                                              | Body      |
| --------------------- | ----------- | ------------------------------------------------ | --------- |
| `fetch` (default)     | GET         | `{base_url}/{operation}?{params as querystring}` | —         |
| `create`              | POST        | `{base_url}/{operation}`                         | JSON body |
| `update`              | PATCH       | `{base_url}/{operation}`                         | JSON body |

The `operation` value becomes a path segment appended directly to `base_url`. Params are
URL-encoded for GET requests and serialised as JSON for POST and PATCH.

### YAML declaration and step example

```yaml
services:
  internal_api:
    adapter: internal_api
    trust: engine_delivered

steps:
  fetch_ticket:
    description: Fetch ticket details from the internal API.
    execution: auto
    depends_on: []
    uses_service: internal_api
    service_method: fetch
    operation: tickets
    input_map:
      id: run.params.ticket_id
```

This calls `GET https://api.example.com/v1/tickets?id={ticket_id}`.

### Errors

| Condition                      | Error code            | `agent_action`   | Retryable |
| ------------------------------ | --------------------- | ---------------- | --------- |
| Client error (HTTP 4xx)        | `SERVICE_HTTP_4XX`    | `report_to_user` | No        |
| Server error (HTTP 5xx)        | `SERVICE_HTTP_5XX`    | `wait_for_human` | Yes       |
| Network unreachable            | `NETWORK_UNREACHABLE` | `wait_for_human` | Yes       |
| Request aborted (step timeout) | `STEP_ABORTED`        | `report_to_user` | No        |

---

## AirtableAdapter

Wraps the Airtable REST API for record-level operations. One adapter instance is scoped
to a single base — for multi-base workflows, register one instance per base. The adapter
is a deterministic workflow-step executor: schema discovery, schema mutation, comments,
and attachments are deliberately out of scope.

### YAML declaration

```yaml
services:
  airtable:
    adapter: airtable
    trust: engine_delivered
```

### Constructor config

| Key        | Type   | Required | Description                                                            |
| ---------- | ------ | -------- | ---------------------------------------------------------------------- |
| `api_key`  | string | Yes      | Personal Access Token (PAT). Rate limit: 5 req/sec per base.           |
| `base_id`  | string | Yes      | Airtable base ID (`appXXXXXXXXXXXXXX`). One adapter instance per base. |
| `base_url` | string | No       | Override for tests only — replaces `https://api.airtable.com`.         |

### Operations — fetch (`service_method: fetch`)

#### `get_record`

Fetches a single record by ID. `GET /v0/{base}/{table}/{record_id}`.

| Parameter   | Type   | Required | Description         |
| ----------- | ------ | -------- | ------------------- |
| `table`     | string | Yes      | Table name.         |
| `record_id` | string | Yes      | Record ID (`rec…`). |

**Response:** the raw Airtable record — `id`, `createdTime`, `fields`.

#### `list_records`

Lists records from a table. `GET /v0/{base}/{table}`.

| Parameter           | Type    | Required | Description                                                                                                                     |
| ------------------- | ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `table`             | string  | Yes      | Table name.                                                                                                                     |
| `filter_by_formula` | string  | No       | Airtable formula, passed as `filterByFormula`.                                                                                  |
| `view`              | string  | No       | View name or ID.                                                                                                                |
| `max_records`       | number  | No       | Passed as `maxRecords`.                                                                                                         |
| `fields`            | array   | No       | Field names to return (repeated `fields[]` params).                                                                             |
| `offset`            | string  | No       | Pagination cursor from a previous response.                                                                                     |
| `sort`              | array   | No       | Array of `{ field, direction? }` — `direction` is `asc` or `desc`. Malformed entries are skipped.                               |
| `fetch_all`         | boolean | No       | Opt-in bounded auto-pagination (see below).                                                                                     |
| `max_pages`         | number  | No       | With `fetch_all`: page cap. Default 3, hard cap 10 (higher values are clamped).                                                 |
| `max_bytes`         | number  | No       | With `fetch_all`: accumulated-size cap as `JSON.stringify(records).length`. Default 100000 (~25K LLM tokens), hard cap 1000000. |

**Response:** the raw Airtable response — `records` array, plus `offset` when more pages exist.

**Auto-pagination (`fetch_all: true`):** the adapter follows the response `offset` cursor,
re-issuing the same query until no pages remain or a cap is hit — whichever comes first.
Caps are stop conditions, not truncation: the page that crossed a limit is kept. The
response `data` is constructed (not raw):

| Field               | Type    | Description                                                            |
| ------------------- | ------- | ---------------------------------------------------------------------- |
| `records`           | array   | All accumulated records.                                               |
| `truncated`         | boolean | `true` when a cap stopped the loop with more pages remaining.          |
| `truncation_reason` | string  | `page_limit` or `byte_limit`. Present only when `truncated` is `true`. |
| `offset`            | string  | Resume cursor. Present only when `truncated` is `true`.                |

> Results returned by the final step of an auto-chain flow verbatim into the calling
> LLM's context. Keep `fetch_all` steps in the middle of an auto-chain feeding a
> handler step (intermediate envelopes are discarded), use `fields` /
> `filter_by_formula` to shrink records, and treat `max_bytes` as your context
> budget: ~4 bytes ≈ 1 token.

**YAML step example:**

```yaml
fetch_open_tickets:
  description: List open tickets from Airtable.
  execution: auto
  uses_service: airtable
  service_method: fetch
  operation: list_records
  input_map:
    table: { $literal: 'Tickets' }
    filter_by_formula: { $literal: "{Status} = 'Open'" }
```

#### `search_records`

Searches records by substring match across named fields, built on `list_records` with a
generated `filterByFormula`. `GET /v0/{base}/{table}?filterByFormula=…`.

| Parameter     | Type   | Required | Description                                                                                                                                                  |
| ------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `table`       | string | Yes      | Table name.                                                                                                                                                  |
| `search_term` | string | Yes      | Substring to find. `"` and `\` are formula-escaped (injection guard).                                                                                        |
| `fields`      | array  | Yes      | Non-empty array of field names to search. Required because the adapter has no schema discovery — by design, the workflow author names the searchable fields. |
| `view`        | string | No       | View name or ID (as in `list_records`).                                                                                                                      |
| `max_records` | number | No       | Passed as `maxRecords` (as in `list_records`).                                                                                                               |

One field produces `FIND("term", {field})`; multiple fields produce
`OR(FIND("term", {field1}),FIND("term", {field2}),…)`. The term is escaped before
interpolation — never embedded raw.

**Response:** the raw Airtable response — `records` array.

### Operations — create (`service_method: create`)

#### `create_record`

Creates a single record. `POST /v0/{base}/{table}`.

| Parameter  | Type    | Required | Description                                         |
| ---------- | ------- | -------- | --------------------------------------------------- |
| `table`    | string  | Yes      | Table name.                                         |
| `fields`   | object  | Yes      | Field values for the new record.                    |
| `typecast` | boolean | No       | When `true`, Airtable coerces value types (opt-in). |

**Response:** the created record — `id`, `createdTime`, `fields`.

### Operations — update (`service_method: update`)

#### `upsert_record`

Upserts a record by merge fields. `POST /v0/{base}/{table}` with `performUpsert`.

| Parameter            | Type    | Required | Description                                            |
| -------------------- | ------- | -------- | ------------------------------------------------------ |
| `table`              | string  | Yes      | Table name.                                            |
| `fields`             | object  | Yes      | Field values to write.                                 |
| `fields_to_merge_on` | array   | Yes      | Non-empty array of field names to match existing rows. |
| `typecast`           | boolean | No       | Opt-in type coercion.                                  |

**Response:** the raw Airtable upsert response — `records`, `createdRecords`, `updatedRecords`.

#### `update_record`

Updates a single record by ID. `PATCH /v0/{base}/{table}/{record_id}` — a partial
update: only the fields provided are written, other fields are left untouched.

| Parameter   | Type    | Required | Description            |
| ----------- | ------- | -------- | ---------------------- |
| `table`     | string  | Yes      | Table name.            |
| `record_id` | string  | Yes      | Record ID (`rec…`).    |
| `fields`    | object  | Yes      | Field values to write. |
| `typecast`  | boolean | No       | Opt-in type coercion.  |

**Response:** the updated record — `id`, `createdTime`, `fields`.

**YAML step example:**

```yaml
close_ticket:
  description: Mark the ticket closed in Airtable.
  execution: auto
  uses_service: airtable
  service_method: update
  operation: update_record
  input_map:
    table: { $literal: 'Tickets' }
    record_id: context.resources.find_ticket.id
    fields: { status: { $literal: 'Closed' } }
```

### Operations — delete (`service_method: delete`)

#### `delete_records`

Deletes up to 10 records in one call. `DELETE /v0/{base}/{table}?records[]=id1&records[]=id2…`.

| Parameter    | Type   | Required | Description                          |
| ------------ | ------ | -------- | ------------------------------------ |
| `table`      | string | Yes      | Table name.                          |
| `record_ids` | array  | Yes      | 1–10 record IDs (non-empty strings). |

**Response:** the raw Airtable response — `records` array of `{ id, deleted: true }`.

> **Deletion is irreversible. Put delete steps behind a human gate.** The adapter
> deliberately caps at 10 records per call and performs no internal chunking.
> Recommended step shape:
>
> ```yaml
> remove_stale_rows:
>   description: Delete the flagged records after human review
>   execution: auto
>   uses_service: airtable
>   service_method: delete
>   operation: delete_records
>   trust: human_confirmed
>   input_map:
>     table: { $literal: 'Tasks' }
>     record_ids: context.resources.flag_stale.record_ids
> ```

### Errors

| Condition                      | Error code                  | `agent_action`     | Retryable |
| ------------------------------ | --------------------------- | ------------------ | --------- |
| Bad params (pre-request)       | `ADAPTER_VALIDATION_FAILED` | `provide_input`    | No        |
| Auth failed (HTTP 401)         | `SERVICE_AUTH_FAILED`       | `stop`             | No        |
| Forbidden (HTTP 403)           | `SERVICE_HTTP_4XX`          | `stop`             | No        |
| Not found (HTTP 404)           | `SERVICE_NOT_FOUND`         | `provide_input`    | No        |
| Unprocessable (HTTP 422)       | `SERVICE_HTTP_4XX`          | `stop`             | No        |
| Rate limited (HTTP 429)        | `SERVICE_RATE_LIMITED`      | `wait_and_proceed` | Yes       |
| Other client error (HTTP 4xx)  | `SERVICE_HTTP_4XX`          | `stop`             | No        |
| Server error (HTTP 5xx)        | `SERVICE_HTTP_5XX`          | `report_to_user`   | Yes       |
| Malformed response body        | `SERVICE_RESPONSE_INVALID`  | `report_to_user`   | No        |
| Network unreachable            | `NETWORK_UNREACHABLE`       | `wait_for_human`   | Yes       |
| Request aborted (step timeout) | `STEP_ABORTED`              | `report_to_user`   | No        |
| Unknown operation              | `ADAPTER_OP_UNSUPPORTED`    | `report_to_user`   | No        |

On HTTP 429 the adapter reads the `Retry-After` header into `retry_after` when present;
Airtable does not send one, so the engine falls back to the adapter's
`defaultRetryAfterSeconds` of **30 seconds**.

---

## GorgiasAdapter

Communicates with the Gorgias helpdesk API. Supports tickets, messages, and customers.
Universal passthrough — the raw Gorgias API response is returned without transformation.

### Constructor config

| Key          | Type   | Required | Description                                                               |
| ------------ | ------ | -------- | ------------------------------------------------------------------------- |
| `domain`     | string | Yes      | Gorgias account subdomain — e.g. `"acme"` resolves to `acme.gorgias.com`. |
| `auth.type`  | string | Yes      | Must be `"basic"`.                                                        |
| `auth.token` | string | Yes      | Combined credential: `"{email}:{api_key}"`.                               |
| `base_url`   | string | No       | Override for tests — replaces `https://{domain}.gorgias.com`.             |

```typescript
import { GorgiasAdapter, ExtensionRegistry } from '@sensigo/realm';

const registry = new ExtensionRegistry();
registry.register(
  'adapter',
  'gorgias',
  new GorgiasAdapter('gorgias', {
    domain: 'acme',
    auth: {
      type: 'basic',
      token: `${process.env['GORGIAS_EMAIL']}:${process.env['GORGIAS_API_KEY']}`,
    },
  }),
);
```

### YAML declaration

```yaml
services:
  gorgias:
    adapter: gorgias
    trust: engine_delivered
```

### Operations — fetch (`service_method: fetch`)

#### `get_ticket`

Fetches a single ticket by ID. `GET /tickets/{ticket_id}`.

| Parameter   | Type   | Required | Description                 |
| ----------- | ------ | -------- | --------------------------- |
| `ticket_id` | number | Yes      | Positive integer ticket ID. |

**Response:** Raw Gorgias ticket object.

---

#### `get_messages`

Fetches messages, paginating across multiple API pages and returning a merged result.

| Parameter   | Type   | Required | Description                                                                     |
| ----------- | ------ | -------- | ------------------------------------------------------------------------------- |
| `ticket_id` | number | No       | Filter to a specific ticket. When omitted, returns messages across all tickets. |
| `limit`     | number | No       | Maximum messages to return. Default 30, cap 200.                                |
| `order_by`  | string | No       | Forwarded to the API as-is when provided.                                       |

**Response:**

| Field       | Type    | Description                                             |
| ----------- | ------- | ------------------------------------------------------- |
| `messages`  | array   | Accumulated messages in API order, up to `limit`.       |
| `truncated` | boolean | `true` when the limit was reached before the last page. |

---

#### `list_tickets`

Single-page ticket search. `GET /tickets?{params}`.

| Parameter     | Type                          | Required | Description                                                                                    |
| ------------- | ----------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| scalar params | `string \| number \| boolean` | No       | Any scalar param (`status`, `assignee_id`, `limit`, `cursor`, etc.) forwarded as query string. |

Non-scalar values (arrays, objects) are silently dropped — there is no multi-value filter syntax.

**Pagination:** the response includes `meta.next_cursor`. Pass it back as `cursor` for the next page. The caller manages the loop.

**YAML step example:**

```yaml
list_open_tickets:
  description: List open Gorgias tickets.
  execution: auto
  uses_service: gorgias
  service_method: fetch
  operation: list_tickets
  input_map:
    status: { $literal: 'open' }
    limit: { $literal: 30 }
```

---

#### `get_customer`

Fetches a single customer by ID. `GET /customers/{customer_id}`.

| Parameter     | Type   | Required | Description                   |
| ------------- | ------ | -------- | ----------------------------- |
| `customer_id` | number | Yes      | Positive integer customer ID. |

**Response:** Raw Gorgias customer object.

---

#### `list_customers`

Single-page customer search. `GET /customers?{params}`. Same scalar-passthrough and cursor-pagination pattern as `list_tickets`.

---

### Operations — create (`service_method: create`)

#### `create_message`

Posts a message on a ticket. `POST /tickets/{ticket_id}/messages`.

| Parameter    | Type   | Required | Description                                                      |
| ------------ | ------ | -------- | ---------------------------------------------------------------- |
| `ticket_id`  | number | Yes      | Ticket to post on. Routed to the URL and stripped from the body. |
| other fields | any    | No       | All remaining params forwarded verbatim as the POST body.        |

---

#### `create_ticket`

Creates a new ticket. `POST /tickets`.

| Parameter  | Type | Required | Description                                  |
| ---------- | ---- | -------- | -------------------------------------------- |
| any fields | any  | No       | All params forwarded as-is as the POST body. |

---

#### `create_customer`

Creates a new customer. `POST /customers`. All params forwarded as the POST body.

---

### Operations — update (`service_method: update`)

#### `update_ticket`

Updates a ticket. `PUT /tickets/{ticket_id}`.

| Parameter    | Type   | Required | Description                                                     |
| ------------ | ------ | -------- | --------------------------------------------------------------- |
| `ticket_id`  | number | Yes      | Ticket to update. Routed to the URL and stripped from the body. |
| other fields | any    | No       | All remaining params forwarded verbatim as the PUT body.        |

---

#### `update_customer`

Updates a customer. `PUT /customers/{customer_id}`.

| Parameter     | Type   | Required | Description                                                       |
| ------------- | ------ | -------- | ----------------------------------------------------------------- |
| `customer_id` | number | Yes      | Customer to update. Routed to the URL and stripped from the body. |
| other fields  | any    | No       | All remaining params forwarded verbatim as the PUT body.          |

---

### Errors

| Condition                      | Error code                  | `agent_action`     | Retryable |
| ------------------------------ | --------------------------- | ------------------ | --------- |
| Bad params (pre-request)       | `ADAPTER_VALIDATION_FAILED` | `provide_input`    | No        |
| Auth failed (HTTP 401)         | `SERVICE_AUTH_FAILED`       | `stop`             | No        |
| Forbidden (HTTP 403)           | `SERVICE_HTTP_4XX`          | `stop`             | No        |
| Not found (HTTP 404)           | `SERVICE_HTTP_4XX`          | `stop`             | No        |
| Other client error (HTTP 4xx)  | `SERVICE_HTTP_4XX`          | `stop`             | No        |
| Rate limited (HTTP 429)        | `SERVICE_RATE_LIMITED`      | `wait_and_proceed` | Yes       |
| Server error (HTTP 5xx)        | `SERVICE_HTTP_5XX`          | `report_to_user`   | Yes       |
| Network unreachable            | `NETWORK_UNREACHABLE`       | `wait_for_human`   | Yes       |
| Request aborted (step timeout) | `STEP_ABORTED`              | `report_to_user`   | No        |
| Unknown operation              | `ADAPTER_OP_UNSUPPORTED`    | `report_to_user`   | No        |

On HTTP 429 the adapter reads `Retry-After` into `retry_after` when present.
Error responses preserve the original HTTP body in `details.body`.

When using the `rate_limit` config on the YAML service declaration, set `min_retry_seconds`
to enforce a floor on retry delay — useful if the Gorgias API sends `Retry-After: 1` while
the actual limit persists longer:

```yaml
services:
  gorgias:
    adapter: gorgias
    trust: engine_delivered
    rate_limit:
      min_retry_seconds: 30
```

---

## ParcelPanelAdapter

Communicates with the ParcelPanel / ParcelWILL tracking API v2. Universal passthrough — the
raw API response is returned without transformation. Multi-store: each store is identified by
a short key and has its own API key.

Exported types: `ParcelPanelOrderBody`, `ParcelPanelShipment` — available from `@sensigo/realm`.

### Constructor config

| Key        | Type                    | Required | Description                                                          |
| ---------- | ----------------------- | -------- | -------------------------------------------------------------------- |
| `stores`   | `Record<string,string>` | Yes      | Map of store key → ParcelPanel API key. At least one entry required. |
| `base_url` | string                  | No       | Override for tests — replaces `https://open.parcelwill.com`.         |

```typescript
import { ParcelPanelAdapter, ExtensionRegistry } from '@sensigo/realm';

const registry = new ExtensionRegistry();
registry.register(
  'adapter',
  'parcelpanel',
  new ParcelPanelAdapter('parcelpanel', {
    stores: {
      mystore: process.env['PARCELPANEL_API_KEY_MYSTORE'] ?? '',
    },
  }),
);
```

### YAML declaration

```yaml
services:
  parcelpanel:
    adapter: parcelpanel
    trust: engine_delivered
```

### Operations — fetch (`service_method: fetch`)

#### `get_tracking`

Looks up an order by order number. `GET /api/v2/tracking/order?order_number={n}`.

| Parameter      | Type   | Required | Description                                                                                                                                |
| -------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `store`        | string | Yes      | Store key. Must match a key in the `stores` config map.                                                                                    |
| `order_number` | string | Yes      | Order number. Leading whitespace is trimmed; a leading `#` is stripped before the request is sent. Pass `"#1030"` or `"1030"` — both work. |

**Response:** Raw ParcelPanel API body (`ParcelPanelOrderBody` shape).

**YAML step example:**

```yaml
fetch_tracking:
  description: Fetch tracking info for the order.
  execution: auto
  uses_service: parcelpanel
  service_method: fetch
  operation: get_tracking
  input_map:
    store: run.params.store
    order_number: run.params.order_number
```

---

#### `get_tracking_by_id`

Looks up an order by Shopify numeric order ID. `GET /api/v2/tracking/order?order_id={id}`.

| Parameter  | Type             | Required | Description                                                                                                                                       |
| ---------- | ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `store`    | string           | Yes      | Store key. Must match a key in the `stores` config map.                                                                                           |
| `order_id` | number \| string | Yes      | Shopify numeric order ID (e.g. `6140516335690`). When passed as a number, must be a positive integer. When passed as a string, must be non-empty. |

**Response:** Raw ParcelPanel API body (`ParcelPanelOrderBody` shape).

---

### Errors

| Condition                      | Error code                  | `agent_action`     | Retryable |
| ------------------------------ | --------------------------- | ------------------ | --------- |
| Bad params (pre-request)       | `ADAPTER_VALIDATION_FAILED` | `provide_input`    | No        |
| Auth failed (HTTP 401)         | `SERVICE_AUTH_FAILED`       | `stop`             | No        |
| Forbidden (HTTP 403)           | `SERVICE_HTTP_4XX`          | `stop`             | No        |
| Not found (HTTP 404)           | `SERVICE_NOT_FOUND`         | `provide_input`    | No        |
| Rate limited (HTTP 429)        | `SERVICE_RATE_LIMITED`      | `wait_and_proceed` | Yes       |
| Other client error (HTTP 4xx)  | `SERVICE_HTTP_4XX`          | `stop`             | No        |
| Server error (HTTP 5xx)        | `SERVICE_HTTP_5XX`          | `report_to_user`   | Yes       |
| Network unreachable            | `NETWORK_UNREACHABLE`       | `wait_for_human`   | Yes       |
| Request aborted (step timeout) | `STEP_ABORTED`              | `report_to_user`   | No        |
| Unknown operation              | `ADAPTER_OP_UNSUPPORTED`    | `report_to_user`   | No        |

---

## ShopifyAdapter

Communicates with the Shopify Admin GraphQL API. A thin GraphQL executor: the caller provides
the complete query string and optional variables; the adapter handles authentication, store
routing, and error classification. Multi-store: each store has its own `shop_domain` and
`access_token`.

### Constructor config

| Key                        | Type   | Required | Description                                                                                               |
| -------------------------- | ------ | -------- | --------------------------------------------------------------------------------------------------------- |
| `stores`                   | object | Yes      | Map of store key → `{ shop_domain, access_token }`. At least one entry required.                          |
| `stores[key].shop_domain`  | string | Yes      | Shopify subdomain — e.g. `"my-store"` resolves to `my-store.myshopify.com`. Must match `*.myshopify.com`. |
| `stores[key].access_token` | string | Yes      | Private app access token (`shpat_…`).                                                                     |
| `api_version`              | string | No       | Shopify Admin API version, e.g. `"2024-04"`. Default: `2024-04`. Format: `YYYY-MM`.                       |
| `base_url`                 | string | No       | Override for tests — replaces `https://{shop_domain}`.                                                    |

```typescript
import { ShopifyAdapter, ExtensionRegistry } from '@sensigo/realm';

const registry = new ExtensionRegistry();
registry.register(
  'adapter',
  'shopify',
  new ShopifyAdapter('shopify', {
    stores: {
      mystore: {
        shop_domain: 'my-store.myshopify.com',
        access_token: process.env['SHOPIFY_ACCESS_TOKEN'] ?? '',
      },
    },
  }),
);
```

### YAML declaration

```yaml
services:
  shopify:
    adapter: shopify
    trust: engine_delivered
```

### Operations — fetch (`service_method: fetch`)

#### `query`

Executes any Shopify Admin GraphQL query or mutation. `POST /admin/api/{version}/graphql.json`.

| Parameter   | Type   | Required | Description                                                     |
| ----------- | ------ | -------- | --------------------------------------------------------------- |
| `store`     | string | Yes      | Store key. Must match a key in the `stores` config map.         |
| `query`     | string | Yes      | Full GraphQL query or mutation string.                          |
| `variables` | object | No       | Variables map. Omitted from the request body when not provided. |

**Response:** Raw GraphQL response body — `{ data: {...} }` or `{ data: {...}, errors: [...] }`.

Non-THROTTLED GraphQL errors (field errors, permission errors, etc.) are returned as-is in the
raw body — the adapter does not throw on them. The caller inspects `result.data.errors` and
decides how to handle partial success.

**YAML step example:**

```yaml
fetch_order:
  description: Fetch the Shopify order by name.
  execution: auto
  uses_service: shopify
  service_method: fetch
  operation: query
  input_map:
    store: run.params.store
    query:
      $literal: |
        query OrderByName($query: String!) {
          orders(first: 1, query: $query) {
            edges {
              node {
                id
                name
                displayFulfillmentStatus
                createdAt
              }
            }
          }
        }
    variables:
      query: 'name:#{{ run.params.order_name }}'
```

### Errors

| Condition                      | Error code                  | `agent_action`     | Retryable |
| ------------------------------ | --------------------------- | ------------------ | --------- |
| Bad params (pre-request)       | `ADAPTER_VALIDATION_FAILED` | `provide_input`    | No        |
| Auth failed (HTTP 401)         | `SERVICE_AUTH_FAILED`       | `stop`             | No        |
| Forbidden (HTTP 403)           | `SERVICE_HTTP_4XX`          | `stop`             | No        |
| Rate limited (HTTP 429)        | `SERVICE_RATE_LIMITED`      | `wait_and_proceed` | Yes       |
| GraphQL `THROTTLED` error      | `SERVICE_RATE_LIMITED`      | `wait_and_proceed` | Yes       |
| Other client error (HTTP 4xx)  | `SERVICE_HTTP_4XX`          | `stop`             | No        |
| Server error (HTTP 5xx)        | `SERVICE_HTTP_5XX`          | `report_to_user`   | Yes       |
| Non-THROTTLED GraphQL errors   | _(pass through)_            | _(pass through)_   | —         |
| Network unreachable            | `NETWORK_UNREACHABLE`       | `wait_for_human`   | Yes       |
| Request aborted (step timeout) | `STEP_ABORTED`              | `report_to_user`   | No        |
| Unknown operation              | `ADAPTER_OP_UNSUPPORTED`    | `report_to_user`   | No        |

On HTTP 429 the adapter reads `Retry-After` into `retry_after` when present. GraphQL
`THROTTLED` uses a fixed `retry_after: 2` seconds.

---

## NotionAdapter

Communicates with the Notion REST API for page, block, and search operations.
Uses Notion API version `2026-03-11`. Single API key — not multi-store.

### Constructor config

| Key        | Type   | Required | Description                                                                  |
| ---------- | ------ | -------- | ---------------------------------------------------------------------------- |
| `api_key`  | string | Yes      | Notion integration token. Obtain from https://www.notion.so/my-integrations. |
| `base_url` | string | No       | Override for tests — replaces `https://api.notion.com`.                      |

```typescript
import { NotionAdapter, ExtensionRegistry } from '@sensigo/realm';

const registry = new ExtensionRegistry();
registry.register(
  'adapter',
  'notion',
  new NotionAdapter('notion', {
    api_key: process.env['NOTION_API_KEY'] ?? '',
  }),
);
```

### YAML declaration

```yaml
services:
  notion:
    adapter: notion
    trust: engine_delivered
```

### Operations — fetch (`service_method: fetch`)

#### `get_page`

Fetches a page by ID. `GET /v1/pages/{page_id}`.

| Parameter           | Type     | Required | Description                                                     |
| ------------------- | -------- | -------- | --------------------------------------------------------------- |
| `page_id`           | string   | Yes      | Notion page ID.                                                 |
| `filter_properties` | string[] | No       | Allowlist of property IDs to include. Reduces response payload. |

**Response:** Raw Notion page object.

---

#### `list_block_children`

Lists child blocks of a page or block. `GET /v1/blocks/{block_id}/children`.

| Parameter      | Type   | Required | Description                                                 |
| -------------- | ------ | -------- | ----------------------------------------------------------- |
| `block_id`     | string | Yes      | Block or page ID.                                           |
| `start_cursor` | string | No       | Pagination cursor from a previous response's `next_cursor`. |
| `page_size`    | number | No       | Number of blocks to return. Notion's default and max apply. |

**Response:** Raw Notion list object — `{ object: "list", results: [...], has_more: boolean, next_cursor: string|null }`.

**Pagination:** pass `next_cursor` back as `start_cursor` on the next call. The caller manages the loop.

---

#### `query_data_source`

Queries a Notion data source (database). `POST /v1/data_sources/{data_source_id}/query`.

| Parameter           | Type     | Required | Description                                                 |
| ------------------- | -------- | -------- | ----------------------------------------------------------- |
| `data_source_id`    | string   | Yes      | Data source (database) ID.                                  |
| `filter`            | object   | No       | Notion filter object, forwarded as-is.                      |
| `sorts`             | array    | No       | Notion sorts array, forwarded as-is.                        |
| `start_cursor`      | string   | No       | Pagination cursor from a previous response's `next_cursor`. |
| `page_size`         | number   | No       | Number of results to return.                                |
| `filter_properties` | string[] | No       | Allowlist of property IDs to include in the response.       |
| `in_trash`          | boolean  | No       | When `true`, queries trashed entries instead.               |

**Response:** Raw Notion list object — `{ object: "list", results: [...], has_more: boolean, next_cursor: string|null }`.

**YAML step example:**

```yaml
query_tasks:
  description: Query open tasks from the Notion database.
  execution: auto
  uses_service: notion
  service_method: fetch
  operation: query_data_source
  input_map:
    data_source_id: { $literal: 'abc123...' }
    filter:
      property: Status
      status:
        equals: In Progress
```

---

#### `search`

Searches across all pages and databases accessible to the integration. `POST /v1/search`.

| Parameter      | Type   | Required | Description                                                                                               |
| -------------- | ------ | -------- | --------------------------------------------------------------------------------------------------------- |
| `query`        | string | No       | Text to search for. When omitted, all accessible objects are returned.                                    |
| `filter`       | object | No       | Must be `{ property: "object", value: "page" \| "database" \| "data_source" }`. Validated before sending. |
| `sort`         | object | No       | Notion sort object, forwarded as-is.                                                                      |
| `start_cursor` | string | No       | Pagination cursor.                                                                                        |
| `page_size`    | number | No       | Number of results to return.                                                                              |

**Response:** Raw Notion list object — `{ object: "list", results: [...], has_more: boolean, next_cursor: string|null }`.

---

### Operations — create (`service_method: create`)

#### `create_page`

Creates a new page. `POST /v1/pages`.

> **Non-retryable on network failure** — retrying a failed create risks creating a duplicate page.

| Parameter    | Type   | Required | Description                                                                           |
| ------------ | ------ | -------- | ------------------------------------------------------------------------------------- |
| `parent`     | object | Yes      | One of: `{ page_id: "..." }`, `{ data_source_id: "..." }`, or `{ workspace: true }`.  |
| `properties` | object | No       | Page properties map, forwarded as-is.                                                 |
| `children`   | array  | No       | Block children to create with the page (max 100). Mutually exclusive with `markdown`. |
| `markdown`   | string | No       | Markdown content to render as blocks. Mutually exclusive with `children`.             |
| `icon`       | object | No       | Notion icon object, forwarded as-is.                                                  |
| `cover`      | object | No       | Notion cover object, forwarded as-is.                                                 |

**Response:** Raw Notion page object (HTTP 200).

---

#### `append_block_children`

Appends block children to an existing page or block. `PATCH /v1/blocks/{block_id}/children`.

> **Non-retryable on network failure** — retrying risks appending duplicate blocks.

| Parameter  | Type   | Required | Description                                                                                                                                      |
| ---------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `block_id` | string | Yes      | Block or page ID to append to.                                                                                                                   |
| `children` | array  | Yes      | Non-empty array of block objects (max 100). Each must be a plain object with a non-empty `type` field.                                           |
| `position` | object | No       | Where to insert: `{ type: "end" }`, `{ type: "start" }`, or `{ type: "after_block", after_block: { id: "..." } }`. Defaults to end when omitted. |

**Response:** Raw Notion list object of created blocks.

---

### Operations — update (`service_method: update`)

#### `update_page`

Updates a page's properties or metadata. `PATCH /v1/pages/{page_id}`.

| Parameter    | Type    | Required | Description                                              |
| ------------ | ------- | -------- | -------------------------------------------------------- |
| `page_id`    | string  | Yes      | Page ID.                                                 |
| `properties` | object  | No       | Properties to update, forwarded as-is.                   |
| `icon`       | object  | No       | New icon, forwarded as-is.                               |
| `cover`      | object  | No       | New cover, forwarded as-is.                              |
| `in_trash`   | boolean | No       | `true` to move the page to trash, `false` to restore it. |
| `is_locked`  | boolean | No       | `true` to lock the page (prevents edits without unlock). |

> `archived` is deprecated — use `in_trash` instead. Passing `archived` throws `ADAPTER_VALIDATION_FAILED`.

**Response:** Raw Notion page object.

---

### Operations — delete (`service_method: delete`)

#### `delete_block`

Deletes (trashes) a block. `DELETE /v1/blocks/{block_id}`.

| Parameter  | Type   | Required | Description |
| ---------- | ------ | -------- | ----------- |
| `block_id` | string | Yes      | Block ID.   |

**Response:** Raw Notion block object of the deleted block.

---

### Errors

| Condition                      | Error code                  | `agent_action`   | Retryable |
| ------------------------------ | --------------------------- | ---------------- | --------- |
| Bad params (pre-request)       | `ADAPTER_VALIDATION_FAILED` | `provide_input`  | No        |
| Bad request (HTTP 400)         | `SERVICE_HTTP_4XX`          | `stop`           | No        |
| Auth failed (HTTP 401)         | `SERVICE_AUTH_FAILED`       | `stop`           | No        |
| Forbidden (HTTP 403)           | `SERVICE_HTTP_4XX`          | `stop`           | No        |
| Not found (HTTP 404)           | `SERVICE_NOT_FOUND`         | `provide_input`  | No        |
| Conflict (HTTP 409)            | `SERVICE_HTTP_4XX`          | `stop`           | No        |
| Rate limited (HTTP 429)        | `SERVICE_RATE_LIMITED`      | `wait_for_human` | Yes       |
| Service unavailable (HTTP 503) | `SERVICE_HTTP_5XX`          | `wait_for_human` | Yes       |
| Other server error (HTTP 5xx)  | `SERVICE_HTTP_5XX`          | `report_to_user` | Yes       |
| Malformed response body        | `SERVICE_RESPONSE_INVALID`  | `report_to_user` | No        |
| Network unreachable            | `NETWORK_UNREACHABLE`       | `wait_for_human` | Yes       |
| Request aborted (step timeout) | `STEP_ABORTED`              | `report_to_user` | No        |
| Unknown operation              | `ADAPTER_OP_UNSUPPORTED`    | `report_to_user` | No        |

HTTP 400 and 409 error responses include the Notion API's own `message` field in the error text.
All errors include the `x-notion-request-id` response header in `details.notionRequestId` when
present — useful for support tickets with Notion.

Note: Notion's HTTP 429 uses `agent_action: wait_for_human` rather than `wait_and_proceed`.
Notion's rate limit documentation does not provide reliable `Retry-After` values; manual
acknowledgement is the safer recovery path.
