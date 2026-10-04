# Realm documentation

<!-- description: Documentation for Realm, the workflow engine an AI agent calls: getting started, concepts, guides, and reference for the workflow file, CLI and MCP tools. -->

Realm is a workflow engine that an AI agent calls. These pages describe Realm as it is on the `main` branch. Where a page shows something that the published version, 0.45.0, does not have yet, the page says so. Every command and output in them came from a run.

## Start here

- [What Realm is, and when to use it](start/what-realm-is.md)
- [Install and first run](start/install-and-first-run.md)
- [How a run moves](start/how-a-run-moves.md)

## Concepts

- [Workflows, steps and the run record](concepts/workflows-steps-and-runs.md)
- [The four step kinds](concepts/step-kinds.md)
- [Order and routing](concepts/order-and-routing.md)
- [Human gates and trust levels](concepts/gates-and-trust.md)
- [Evidence, and how a run ends](concepts/evidence.md)
- [Who drives a run](concepts/who-drives-a-run.md)

## Guides

- [Write your first workflow](guides/first-workflow.md)
- [Call a service with an adapter](guides/call-a-service.md)
- [Write an agent step](guides/agent-steps.md)
- [Give an agent step tools](guides/agent-tools.md)
- [Add a human gate](guides/human-gates.md)
- [Write a step handler](guides/step-handlers.md)
- [Run a workflow with `realm agent`](guides/realm-agent.md)
- [Connect an MCP client](guides/connect-an-mcp-client.md)
- [Start runs from webhooks](guides/webhooks.md)
- [Answer gates from Slack](guides/slack-gates.md)
- [Handle failure](guides/handle-failure.md)
- [Start runs safely](guides/idempotency-and-batches.md)
- [Test a workflow](guides/test-a-workflow.md)
- [Operate runs](guides/operate-runs.md)
- [Deploy a project](guides/deploy.md)
- [Let an assistant plan its own workflow](guides/agent-created-workflows.md)
- [Upgrade Realm](guides/upgrade.md)

## Reference: the workflow file

- [Workflow file: top-level fields](reference/workflow/top-level-fields.md)
- [Workflow file: step fields](reference/workflow/step-fields.md)
- [Input maps, template expressions and filters](reference/workflow/input-map-and-templates.md)
- [Conditions: `when`, `preconditions`, `abort_unless`](reference/workflow/conditions.md)
- [Gates: `trust` and the `gate` block](reference/workflow/gates.md)
- [Retry and timeouts](reference/workflow/retry-and-timeouts.md)
- [Agent-step controls](reference/workflow/agent-step-controls.md)
- [Services, tool servers, step templates, profiles and workflow context](reference/workflow/services-profiles-and-context.md)
- [Webhook trigger](reference/workflow/webhook-trigger.md)
- [JSON Schema blocks](reference/workflow/json-schema-blocks.md)
- [What the loader refuses and warns about](reference/workflow/loader-diagnostics.md)

## Reference: the command line

- [`realm workflow`](reference/cli/realm-workflow.md)
- [`realm run`: commands that read](reference/cli/realm-run-reading.md)
- [`realm run`: commands that act](reference/cli/realm-run-acting.md)
- [`realm agent`](reference/cli/realm-agent.md)
- [`realm listen`](reference/cli/realm-listen.md)
- [`realm mcp` and `realm serve`](reference/cli/realm-mcp-and-serve.md)

## Reference: MCP

- [MCP tools](reference/mcp/tools.md)
- [Run state and health findings](reference/mcp/run-state-and-health.md)

## Reference: code and settings

- [Adapters](reference/adapters.md)
- [Handlers](reference/handlers.md)
- [Deployment manifest (`realm.yaml`)](reference/deployment-manifest.md)
- [Project extensions](reference/project-extensions.md)
- [Testing package](reference/testing-package.md)
- [Core library: stores and the store contract](reference/core-library.md)

## Reference: lookups

- [Error codes](reference/error-codes.md)
- [Run record and export bundle format](reference/run-record-and-export.md)
- [Environment variables and files on disk](reference/environment-and-files.md)
- [Glossary](reference/glossary.md)
