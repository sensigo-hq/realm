# Built-in Service Adapters

Reference documentation for the three service adapters shipped with `@sensigo/realm`:
`FileSystemAdapter`, `GitHubAdapter`, and `GenericHttpAdapter`. Each adapter implements
`ServiceAdapter` from `@sensigo/realm` and can be registered with `ExtensionRegistry`.
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

| Parameter           | Type   | Required | Description                                                                                       |
| ------------------- | ------ | -------- | ------------------------------------------------------------------------------------------------- |
| `table`             | string | Yes      | Table name.                                                                                       |
| `filter_by_formula` | string | No       | Airtable formula, passed as `filterByFormula`.                                                    |
| `view`              | string | No       | View name or ID.                                                                                  |
| `max_records`       | number | No       | Passed as `maxRecords`.                                                                           |
| `fields`            | array  | No       | Field names to return (repeated `fields[]` params).                                               |
| `offset`            | string | No       | Pagination cursor from a previous response.                                                       |
| `sort`              | array  | No       | Array of `{ field, direction? }` — `direction` is `asc` or `desc`. Malformed entries are skipped. |

**Response:** the raw Airtable response — `records` array, plus `offset` when more pages exist.

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
