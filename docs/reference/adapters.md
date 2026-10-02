# Adapters

An adapter is the code that talks to one kind of outside service. Realm ships 10. This page lists each one's settings and operations. For every operation it gives the parameters and the HTTP request the adapter sends.

The request shown for each operation is the one the adapter sent when the operation was run against a local stand-in for the service. No call was made to the real services. The parameter lists were read from the adapters' code.

| Name in `use:` | Talks to                                      | Settings needed                          |
| -------------- | --------------------------------------------- | ---------------------------------------- |
| `filesystem`   | Files on the machine that runs the step.      | None.                                    |
| `http`         | Any HTTP service that takes and returns JSON. | `base_url`.                              |
| `github`       | GitHub's REST API.                            | None for public data; a token otherwise. |
| `slack`        | A Slack incoming webhook.                     | `webhook_url`.                           |
| `airtable`     | One Airtable base.                            | `api_key`, `base_id`.                    |
| `gorgias`      | Gorgias, a helpdesk.                          | `domain`, `auth`.                        |
| `shopify`      | Shopify's Admin GraphQL API.                  | `stores`.                                |
| `notion`       | Notion's API.                                 | `api_key`.                               |
| `parcelpanel`  | ParcelPanel, an order-tracking service.       | `stores`.                                |
| `mock`         | Nothing. It is for tests written in code.     | None.                                    |

To write an adapter of your own, see [Project extensions](project-extensions.md).

## How a step uses an adapter

An adapter is set up in the project's `realm.yaml`, under a name you choose:

```yaml
version: 1
adapters:
  orders:
    use: airtable
    config:
      api_key: '${secret:AIRTABLE_TOKEN}'
      base_id: appAAAAAAAAAAAAAA
```

A workflow gives that name to a service, and an `auto` step calls the service:

```yaml
services:
  orders:
    adapter: orders

steps:
  find_order:
    description: Find the order.
    execution: auto
    uses_service: orders
    service_method: fetch
    operation: get_record
    input_map:
      table: run.params.table
      record_id: run.params.record_id
```

| Step field       | Holds                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `uses_service`   | The service's name.                                                                              |
| `service_method` | `fetch`, `create`, `update` or `delete`. Default `fetch`. Each operation belongs to one of them. |
| `operation`      | The operation's name.                                                                            |
| `input_map`      | The operation's parameters.                                                                      |

The step's output is what the operation returns. `filesystem` is the only adapter that works without `realm.yaml`: a workflow can name it directly, with `adapter: filesystem`.

See [`realm.yaml`](deployment-manifest.md) for the file, and [Call a service with an adapter](../guides/call-a-service.md) for a walk through one.

## When a call fails

A failed call fails the step. These are the codes the adapters use:

| Code                            | Means                                                                          | Tried again by `retry` |
| ------------------------------- | ------------------------------------------------------------------------------ | ---------------------- |
| `ADAPTER_VALIDATION_FAILED`     | A parameter is missing or has the wrong type. No request was sent.             | No                     |
| `ADAPTER_OP_UNSUPPORTED`        | The adapter has no such operation for that `service_method`.                   | No                     |
| `ENGINE_ADAPTER_NOT_REGISTERED` | No adapter of that name is set up. The step is blocked and the run stays open. | —                      |
| `NETWORK_UNREACHABLE`           | The service could not be reached.                                              | Yes                    |
| `SERVICE_AUTH_FAILED`           | The service refused the credentials (HTTP 401).                                | No                     |
| `SERVICE_NOT_FOUND`             | The service has no such record (HTTP 404).                                     | No                     |
| `SERVICE_RATE_LIMITED`          | The service asked for fewer requests (HTTP 429).                               | Yes                    |
| `SERVICE_HTTP_4XX`              | Another refusal by the service.                                                | No                     |
| `SERVICE_HTTP_5XX`              | The service failed.                                                            | Yes                    |
| `SERVICE_RESPONSE_INVALID`      | The service's reply was not what the adapter expects.                          | No                     |
| `STEP_ABORTED`                  | The step ran out of time while the call was in progress.                       | No                     |

`github` and `http` report every refusal by the service as `SERVICE_HTTP_4XX`, and `github`, `filesystem` and `mock` report an unknown operation as `ENGINE_ADAPTER_FAILED`. See [Retry and timeouts](workflow/retry-and-timeouts.md).

Some of the messages:

```text
ADAPTER_OP_UNSUPPORTED: Adapter 'gh' does not support service_method 'delete'
ADAPTER_VALIDATION_FAILED: AirtableAdapter: table param must be a non-empty string
ENGINE_ADAPTER_NOT_REGISTERED: Adapter 'stripe' for service 'stripe' is not registered. Declare this adapter under 'adapters:' in realm.yaml at your deployment root.
```

## `filesystem`

Reads a text file. It has no settings.

| `service_method` | `operation` | Parameters          | Returns                                       |
| ---------------- | ----------- | ------------------- | --------------------------------------------- |
| `fetch`          | `read`      | `path`, a full path | `content`, `path`, `line_count`, `size_bytes` |

| Failure                     | Code and message                                             |
| --------------------------- | ------------------------------------------------------------ |
| The path is not a full path | `VALIDATION_INPUT_SCHEMA`: `path must be absolute`           |
| There is no such file       | `RESOURCE_FETCH_FAILED`: `file not found: /nowhere/note.txt` |
| `create` or `update`        | `ENGINE_ADAPTER_FAILED`: `not supported`                     |

## `http`

Calls any JSON service. The step's `operation` is the path under `base_url`.

| Setting            | Required | Holds                                                                                |
| ------------------ | -------- | ------------------------------------------------------------------------------------ |
| `base_url`         | Yes      | The start of every address.                                                          |
| `headers`          | No       | Headers sent with every request.                                                     |
| `auth.type`        | No       | `bearer`, `basic` or `header`.                                                       |
| `auth.token`       | No       | The credential. For `basic`, `user:password`.                                        |
| `auth.header_name` | No       | For `header`: the name of the header that carries the token. Default `X-Auth-Token`. |

| `service_method` | Request sent                                                           |
| ---------------- | ---------------------------------------------------------------------- |
| `fetch`          | `GET <base_url>/<operation>`, with the parameters as the query string. |
| `create`         | `POST <base_url>/<operation>`, with the parameters as a JSON body.     |
| `update`         | `PATCH <base_url>/<operation>`, with the parameters as a JSON body.    |

With `base_url: http://127.0.0.1:4995/v1`, `operation: orders` and the parameters `status: open` and `limit: 2`, a `fetch` sent `GET /v1/orders?status=open&limit=2` and a `create` sent `POST /v1/orders` with the body `{"status":"open","limit":2}`. Both carried `Authorization: Bearer <token>` and the header from `headers`.

It returns the service's reply, which must be JSON.

## `github`

| Setting      | Required | Holds                                            |
| ------------ | -------- | ------------------------------------------------ |
| `auth.token` | No       | A GitHub token. Sent as `Authorization: Bearer`. |
| `base_url`   | No       | Default `https://api.github.com`.                |

`repo` is written as `owner/name`.

| `service_method` | `operation`              | Parameters                                      | Request sent                                                                           |
| ---------------- | ------------------------ | ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| `fetch`          | `get_pr_diff`            | `repo`, `pr_number`                             | `GET /repos/<repo>/pulls/<pr_number>/files` then `GET /repos/<repo>/pulls/<pr_number>` |
| `fetch`          | `get_linked_issues`      | `repo`, `pr_number`                             | `GET /repos/<repo>/issues?pr=…`                                                        |
| `fetch`          | `get_issue`              | `repo`, `issue_number`                          | `GET /repos/<repo>/issues/<issue_number>`                                              |
| `fetch`          | `get_issue_comments`     | `repo`, `issue_number`                          | `GET /repos/<repo>/issues/<issue_number>/comments`                                     |
| `fetch`          | `get_file_contents`      | `repo`, `path`; optional `ref`                  | `GET /repos/<repo>/contents/<path>?ref=…`                                              |
| `fetch`          | `get_pr_review_comments` | `repo`, `pr_number`                             | `GET /repos/<repo>/pulls/<pr_number>/comments`                                         |
| `create`         | `post_comment`           | `repo`, `issue_number` or `pr_number`, `body`   | `POST /repos/<repo>/issues/<issue_number>/comments`                                    |
| `create`         | `apply_labels`           | `repo`, `issue_number` or `pr_number`, `labels` | `POST /repos/<repo>/issues/<issue_number>/labels`                                      |
| `update`         | `set_pr_description`     | `repo`, `pr_number`, `body`                     | `PATCH /repos/<repo>/pulls/<pr_number>`                                                |

| Operation                | Returns                                                                     |
| ------------------------ | --------------------------------------------------------------------------- |
| `get_pr_diff`            | `diff_text`, `pr_title`, `base_branch`, `head_sha`, `files_changed`, `repo` |
| `get_issue_comments`     | A list of `author`, `body`, `created_at`                                    |
| `get_file_contents`      | `path`, and `content` as text                                               |
| `get_pr_review_comments` | A list of `file`, `line`, `author`, `body`                                  |
| `set_pr_description`     | `ok: true` and the new `body`                                               |
| The others               | GitHub's reply, unchanged                                                   |

A `404` is reported with the likely causes: the repository or number does not exist, or the token cannot see a private repository.

## `slack`

Posts a message through an incoming webhook. To ask a person for a gate's answer in Slack, see [Answer gates from Slack](../guides/slack-gates.md), which uses a different setting.

| Setting       | Required | Holds                  |
| ------------- | -------- | ---------------------- |
| `webhook_url` | Yes      | The webhook's address. |

| `service_method` | `operation`    | Parameters                | Request sent            |
| ---------------- | -------------- | ------------------------- | ----------------------- |
| `create`         | `post_message` | `text`; optional `blocks` | `POST` to `webhook_url` |

It returns `ok: true`. `fetch` and `update` are refused: `SlackAdapter does not support fetch`.

## `airtable`

One adapter works on one base. For two bases, set up two adapters.

| Setting    | Required | Holds                                                  |
| ---------- | -------- | ------------------------------------------------------ |
| `api_key`  | Yes      | A personal access token.                               |
| `base_id`  | Yes      | The base's ID: `app` followed by 14 letters or digits. |
| `base_url` | No       | Default `https://api.airtable.com`.                    |

| `service_method` | `operation`      | Parameters                                                                                                                      | Request sent                               |
| ---------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `fetch`          | `get_record`     | `table`, `record_id`                                                                                                            | `GET /v0/<base_id>/<table>/<record_id>`    |
| `fetch`          | `list_records`   | `table`; optional `filter_by_formula`, `view`, `max_records`, `fields`, `sort`, `offset`, `fetch_all`, `max_pages`, `max_bytes` | `GET /v0/<base_id>/<table>`                |
| `fetch`          | `search_records` | `table`, `search_term`, `fields`; optional `view`, `max_records`                                                                | `GET /v0/<base_id>/<table>`                |
| `create`         | `create_record`  | `table`, `fields`; optional `typecast`                                                                                          | `POST /v0/<base_id>/<table>`               |
| `update`         | `upsert_record`  | `table`, `fields`, `fields_to_merge_on`; optional `typecast`                                                                    | `PATCH /v0/<base_id>/<table>`              |
| `update`         | `update_record`  | `table`, `record_id`, `fields`; optional `typecast`                                                                             | `PATCH /v0/<base_id>/<table>/<record_id>`  |
| `delete`         | `delete_records` | `table`, `record_ids`                                                                                                           | `DELETE /v0/<base_id>/<table>?records[]=…` |

- **`list_records`** sends `filter_by_formula`, `view` and `max_records` as Airtable's `filterByFormula`, `view` and `maxRecords`. `fields` is a list of field names. `sort` is a list of `field` and `direction`. It returns one page, as Airtable does, with `offset` when there are more.
- **`fetch_all: true`** reads several pages and returns `records` and `truncated`. It stops after `max_pages` pages (default 3, at most 10) or `max_bytes` bytes (default 100000, at most 1000000), and then also returns `truncation_reason` and `offset`.
- **`search_records`** looks for `search_term` in each of the named `fields`. It sent `filterByFormula=OR(FIND("ana", {Name}),FIND("ana", {Status}))`.
- **`upsert_record`** sends `{"records":[{"fields":…}],"performUpsert":{"fieldsToMergeOn":[…]}}`.
- **`delete_records`** takes a list of record IDs.

Each operation returns Airtable's reply, unchanged.

## `gorgias`

| Setting      | Required | Holds                                                   |
| ------------ | -------- | ------------------------------------------------------- |
| `domain`     | Yes      | The account's subdomain: `acme` for `acme.gorgias.com`. |
| `auth.type`  | Yes      | `basic`.                                                |
| `auth.token` | Yes      | `<email>:<api key>`.                                    |
| `base_url`   | No       | Default `https://<domain>.gorgias.com/api`.             |

| `service_method` | `operation`       | Parameters                                                                         | Request sent                         |
| ---------------- | ----------------- | ---------------------------------------------------------------------------------- | ------------------------------------ |
| `fetch`          | `get_ticket`      | `ticket_id`                                                                        | `GET /tickets/<ticket_id>`           |
| `fetch`          | `list_tickets`    | Optional: any of the service's list filters, such as `order_by`, `cursor`, `limit` | `GET /tickets`                       |
| `fetch`          | `get_messages`    | Optional `ticket_id`, `limit`, `order_by`                                          | `GET /tickets/<ticket_id>/messages`  |
| `fetch`          | `get_customer`    | `customer_id`                                                                      | `GET /customers/<customer_id>`       |
| `fetch`          | `list_customers`  | Optional: any of the service's list filters, such as `cursor`, `limit`             | `GET /customers`                     |
| `create`         | `create_message`  | `ticket_id`, and the message's fields                                              | `POST /tickets/<ticket_id>/messages` |
| `create`         | `create_ticket`   | `messages`, and the ticket's fields                                                | `POST /tickets`                      |
| `create`         | `create_customer` | `channels`, and the customer's fields                                              | `POST /customers`                    |
| `update`         | `update_ticket`   | `ticket_id`, and the fields to change                                              | `PUT /tickets/<ticket_id>`           |
| `update`         | `update_customer` | `customer_id`, and the fields to change                                            | `PUT /customers/<customer_id>`       |

- **`list_tickets` and `list_customers`** send every parameter as a query filter and return one page: the service's `data` and `meta`, and `has_more`. Pass `meta.next_cursor` as `cursor` for the next page. A parameter that is a list or an object is refused.
- **`get_messages`** reads as many pages as it needs and returns `messages` and `truncated`. Without `limit` it returns up to 500 messages of a ticket. Without `ticket_id` it reads messages across all tickets, up to 30.
- **The create and update operations** send every parameter other than the ID as the JSON body.

The other operations return the service's reply, unchanged.

## `shopify`

| Setting                      | Required | Holds                                             |
| ---------------------------- | -------- | ------------------------------------------------- |
| `stores.<name>.shop_domain`  | Yes      | The store's domain, such as `demo.myshopify.com`. |
| `stores.<name>.access_token` | Yes      | The store's Admin API token.                      |
| `api_version`                | No       | Default `2024-04`.                                |
| `base_url`                   | No       | Replaces `https://<shop_domain>`.                 |

`stores` has one entry for each store, under a name you choose. The `store` parameter picks one.

| `service_method` | `operation` | Parameters                             | Request sent                           |
| ---------------- | ----------- | -------------------------------------- | -------------------------------------- |
| `fetch`          | `query`     | `store`, `query`; optional `variables` | `POST /admin/api/2024-04/graphql.json` |

`query` is a complete GraphQL query, and `variables` its variables. It returns Shopify's reply, unchanged, including any `errors` in it. A reply that says the store is throttling requests is reported as `SERVICE_RATE_LIMITED`.

A `shop_domain` that does not end in `.myshopify.com` stops the project from loading: `ShopifyAdapter: invalid shop_domain for store "main"`.

## `notion`

| Setting    | Required | Holds                             |
| ---------- | -------- | --------------------------------- |
| `api_key`  | Yes      | An integration token.             |
| `base_url` | No       | Default `https://api.notion.com`. |

Every request carries `Notion-Version: 2026-03-11`.

| `service_method` | `operation`             | Parameters                                                                                                 | Request sent                                   |
| ---------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `fetch`          | `get_page`              | `page_id`; optional `filter_properties`                                                                    | `GET /v1/pages/<page_id>`                      |
| `fetch`          | `list_block_children`   | `block_id`; optional `start_cursor`, `page_size`                                                           | `GET /v1/blocks/<block_id>/children`           |
| `fetch`          | `query_data_source`     | `data_source_id`; optional `filter`, `sorts`, `start_cursor`, `page_size`, `in_trash`, `filter_properties` | `POST /v1/data_sources/<data_source_id>/query` |
| `fetch`          | `search`                | Optional `query`, `filter`, `sort`, `start_cursor`, `page_size`                                            | `POST /v1/search`                              |
| `create`         | `create_page`           | `parent`; optional `properties`, `children` or `markdown`, `icon`, `cover`                                 | `POST /v1/pages`                               |
| `create`         | `append_block_children` | `block_id`, `children`; optional `position`                                                                | `PATCH /v1/blocks/<block_id>/children`         |
| `update`         | `update_page`           | `page_id`; optional `properties`, `icon`, `cover`, `in_trash`, `is_locked`                                 | `PATCH /v1/pages/<page_id>`                    |
| `delete`         | `delete_block`          | `block_id`                                                                                                 | `DELETE /v1/blocks/<block_id>`                 |

- **`create_page`**: `parent` is `{page_id: …}`, `{data_source_id: …}` or `{workspace: true}`. Give the content as `children`, a list of at most 100 blocks, or as `markdown`, not both.
- **`append_block_children`**: `children` is a list of 1 to 100 blocks. `position` is `{type: end}`, `{type: start}` or `{type: after_block, after_block: {id: …}}`.
- **`search`**: `filter` is `{property: object, value: page}`, with `database` or `data_source` as the other values.
- **`update_page`**: use `in_trash`; `archived` is refused.

Each operation returns Notion's reply, unchanged.

## `parcelpanel`

| Setting         | Required | Holds                                  |
| --------------- | -------- | -------------------------------------- |
| `stores.<name>` | Yes      | The store's ParcelPanel API key.       |
| `base_url`      | No       | Default `https://open.parcelwill.com`. |

`stores` has one entry for each store, under a name you choose. The `store` parameter picks one.

| `service_method` | `operation`          | Parameters              | Request sent                                |
| ---------------- | -------------------- | ----------------------- | ------------------------------------------- |
| `fetch`          | `get_tracking`       | `store`, `order_number` | `GET /api/v2/tracking/order?order_number=…` |
| `fetch`          | `get_tracking_by_id` | `store`, `order_id`     | `GET /api/v2/tracking/order?order_id=…`     |

`order_number` may be written with or without a leading `#`: `#1030` was sent as `1030`. `order_id` is Shopify's numeric order ID. Both return the service's reply, unchanged.

## `mock`

`mock` answers each operation with a reply it was given when it was created in code. Set up from `realm.yaml` it has none, so every operation fails with `MockAdapter: unknown operation`. It is exported for tests. See [The testing package](testing-package.md).

## Settings that `realm.yaml` refuses

| The entry has                       | Message                                                                                                                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A `use:` that is not in the list    | `adapters.gh — unknown catalog adapter 'gitlab'. Valid catalog names (realm v0.45.0): github, slack, http, airtable, gorgias, shopify, notion, parcelpanel, filesystem, mock. …` |
| `config:` on `filesystem` or `mock` | `adapters.gh — catalog adapter 'filesystem' takes no config; remove the 'config:' block.`                                                                                        |
| No `use:`                           | `adapters.gh needs 'use:' — a catalog name (adapters) or a module reference './path.js#Export'.`                                                                                 |

## See also

- [Call a service with an adapter](../guides/call-a-service.md)
- [`realm.yaml`](deployment-manifest.md)
- [Project extensions](project-extensions.md) covers adapters of your own.
- [Services, tool servers, step templates, profiles and workflow context](workflow/services-profiles-and-context.md) covers `services` and `rate_limit`.
