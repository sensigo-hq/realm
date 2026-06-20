// Workflow YAML loader — parses workflow.yaml files into typed WorkflowDefinition objects.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { load } from 'js-yaml';
import { Ajv } from 'ajv';
import type {
  WorkflowDefinition,
  TemplateDefinition,
  TriggerRule,
} from '../types/workflow-definition.js';
import { WorkflowError } from '../types/workflow-error.js';
import { resolveTemplates } from './template-resolver.js';
import type { ExtensionRegistry } from '../extensions/registry.js';
import {
  normalizeTriggerFilter,
  validateTriggerStructure,
  emitTriggerWarnings,
} from './trigger-schema.js';

/** Bumped on every breaking change to WorkflowDefinition's serialized format. */
export const CURRENT_WORKFLOW_SCHEMA_VERSION = 1;

const VALID_EXECUTIONS = new Set(['auto', 'agent', 'guard']);
const VALID_SERVICE_METHODS = new Set(['fetch', 'create', 'update', 'delete']);
const VALID_TRIGGER_RULES = new Set<TriggerRule>([
  'all_success',
  'all_failed',
  'all_done',
  'one_failed',
  'one_success',
  'none_failed',
]);

/**
 * Loads a WorkflowDefinition from a YAML file on disk.
 * @throws WorkflowError on read failure or structural validation errors.
 */
export function loadWorkflowFromFile(
  filePath: string,
  registry?: ExtensionRegistry,
): WorkflowDefinition {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new WorkflowError(`Failed to read workflow file: ${message}`, {
      code: 'RESOURCE_FETCH_FAILED',
      category: 'RESOURCE',
      agentAction: 'report_to_user',
      retryable: false,
    });
  }
  const definition = loadWorkflowFromString(content, registry);

  // Resolve agent profiles — only possible when we have a file path.
  const workflowDir = dirname(resolve(filePath));
  const profilesDir =
    definition.profiles_dir !== undefined
      ? resolve(workflowDir, definition.profiles_dir)
      : join(workflowDir, 'profiles');

  const resolvedProfiles: Record<string, { content: string; content_hash: string }> = {};
  const profileErrors: string[] = [];

  for (const [stepName, step] of Object.entries(definition.steps)) {
    if (step.agent_profile === undefined) continue;
    const profileName = step.agent_profile;
    if (profileName in resolvedProfiles) continue;

    const profilePath = join(profilesDir, `${profileName}.md`);
    let profileContent: string;
    try {
      profileContent = readFileSync(profilePath, 'utf8');
    } catch {
      profileErrors.push(
        `Step '${stepName}': agent_profile '${profileName}' not found. Searched: ${profilePath}`,
      );
      continue;
    }

    const contentHash = createHash('sha256').update(profileContent).digest('hex');
    resolvedProfiles[profileName] = { content: profileContent, content_hash: contentHash };
  }

  if (profileErrors.length > 0) {
    throw new WorkflowError(`Invalid workflow: ${profileErrors.join('; ')}`, {
      code: 'VALIDATION_WORKFLOW_SCHEMA',
      category: 'VALIDATION',
      agentAction: 'report_to_user',
      retryable: false,
    });
  }

  if (Object.keys(resolvedProfiles).length > 0) {
    definition.resolved_profiles = resolvedProfiles;
  }

  // Validate context_wrapper if present.
  if (definition.context_wrapper !== undefined) {
    const VALID_WRAPPER_FORMATS = new Set(['xml', 'brackets', 'none']);
    if (!VALID_WRAPPER_FORMATS.has(definition.context_wrapper)) {
      throw new WorkflowError(
        `Invalid context_wrapper '${String(definition.context_wrapper)}'; must be 'xml', 'brackets', or 'none'`,
        {
          code: 'VALIDATION_WORKFLOW_SCHEMA',
          category: 'VALIDATION',
          agentAction: 'report_to_user',
          retryable: false,
        },
      );
    }
  }

  // Validate and resolve workflow_context entry paths.
  if (definition.workflow_context !== undefined) {
    for (const [name, entry] of Object.entries(definition.workflow_context)) {
      if (name.endsWith('.raw')) {
        throw new WorkflowError(
          `workflow_context entry names must not end with '.raw' (found: '${name}')`,
          {
            code: 'VALIDATION_WORKFLOW_SCHEMA',
            category: 'VALIDATION',
            agentAction: 'report_to_user',
            retryable: false,
          },
        );
      }
      if (!/^[\w.]+$/.test(name)) {
        throw new WorkflowError(
          `workflow_context entry name '${name}' is invalid; names must match [\\w.]+ (underscores and dots only — no hyphens)`,
          {
            code: 'VALIDATION_WORKFLOW_SCHEMA',
            category: 'VALIDATION',
            agentAction: 'report_to_user',
            retryable: false,
          },
        );
      }
      const rawEntry = entry as unknown as Record<string, unknown>;
      const rawSource = rawEntry['source'] as Record<string, unknown> | undefined;
      if (rawSource === undefined || typeof rawSource['path'] !== 'string') {
        throw new WorkflowError(`workflow_context.${name}.source.path is required`, {
          code: 'VALIDATION_WORKFLOW_SCHEMA',
          category: 'VALIDATION',
          agentAction: 'report_to_user',
          retryable: false,
        });
      }
      // Resolve relative path to absolute.
      entry.source.path = resolve(workflowDir, rawSource['path'] as string);
    }
  }

  // Auto-register schema.json if present and not explicitly declared.
  const schemaPath = join(workflowDir, 'schema.json');
  if (existsSync(schemaPath) && definition.workflow_context?.['schema'] === undefined) {
    definition.workflow_context ??= {};
    definition.workflow_context['schema'] = {
      source: { path: schemaPath },
      description: 'Auto-registered schema.json from workflow directory',
    };
  }

  definition.origin = 'human';

  return definition;
}

/**
 * Loads a WorkflowDefinition from a YAML string.
 * Validates structure and DAG dependency references.
 * @throws WorkflowError on parse failure or structural validation errors.
 */
export function loadWorkflowFromString(
  content: string,
  registry?: ExtensionRegistry,
): WorkflowDefinition {
  // Step 1: Parse YAML
  let raw: unknown;
  try {
    raw = load(content);
  } catch (err) {
    throw new WorkflowError(
      `YAML parse error: ${err instanceof Error ? err.message : String(err)}`,
      {
        code: 'RESOURCE_FORMAT_INVALID',
        category: 'RESOURCE',
        agentAction: 'report_to_user',
        retryable: false,
      },
    );
  }

  const errors: string[] = [];

  // Step 2: Top-level validation
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new WorkflowError('Invalid workflow: Workflow must be a non-null object', {
      code: 'VALIDATION_WORKFLOW_SCHEMA',
      category: 'VALIDATION',
      agentAction: 'report_to_user',
      retryable: false,
    });
  }

  const doc = raw as Record<string, unknown>;
  const REQUIRED_TOP_LEVEL = ['id', 'name', 'version', 'steps'];
  for (const field of REQUIRED_TOP_LEVEL) {
    if (!(field in doc)) {
      errors.push(`Missing required field: '${field}'`);
    }
  }

  if ('version' in doc && typeof doc['version'] !== 'number') {
    errors.push(`'version' must be a number`);
  }
  if (
    'steps' in doc &&
    (typeof doc['steps'] !== 'object' || doc['steps'] === null || Array.isArray(doc['steps']))
  ) {
    errors.push(`'steps' must be a non-null object`);
  }

  if (errors.length > 0) {
    throw new WorkflowError(`Invalid workflow: ${errors.join('; ')}`, {
      code: 'VALIDATION_WORKFLOW_SCHEMA',
      category: 'VALIDATION',
      agentAction: 'report_to_user',
      retryable: false,
    });
  }

  // Step 1b: Resolve template instantiations before validation.
  const rawTemplates = (doc['templates'] ?? {}) as Record<string, TemplateDefinition>;
  if (Object.keys(rawTemplates).length > 0 || hasUseTemplateInSteps(doc['steps'])) {
    doc['steps'] = resolveTemplates(doc['steps'] as Record<string, unknown>, rawTemplates);
  }

  const stepsRaw = doc['steps'] as Record<string, unknown>;

  // Step 3: Per-step validation
  for (const [stepName, stepRaw] of Object.entries(stepsRaw)) {
    if (typeof stepRaw !== 'object' || stepRaw === null || Array.isArray(stepRaw)) {
      errors.push(`Step '${stepName}' must be an object`);
      continue;
    }
    const step = stepRaw as Record<string, unknown>;

    if (stepName === 'run' || stepName === 'context') {
      errors.push(`Step name '${stepName}' is reserved and cannot be used as a step identifier`);
    }

    const REQUIRED_STEP = ['description', 'execution'];
    for (const field of REQUIRED_STEP) {
      if (!(field in step)) {
        errors.push(`Step '${stepName}': missing required field '${field}'`);
      }
    }

    if ('execution' in step && !VALID_EXECUTIONS.has(step['execution'] as string)) {
      errors.push(
        `Step '${stepName}': invalid execution value '${String(step['execution'])}'; must be 'auto', 'agent', or 'guard'`,
      );
    }

    // Guard step constraints.
    if (step['execution'] === 'guard') {
      const prohibited = [
        'uses_service',
        'handler',
        'input_schema',
        'output_schema',
        'trust',
        'agent_profile',
        'trigger_rule',
        'timeout_seconds',
        'service_method',
        'operation',
        'input_map',
        'tools',
      ];
      for (const field of prohibited) {
        if (step[field] !== undefined) {
          errors.push(`Step '${stepName}': '${field}' is not valid on execution: guard steps`);
        }
      }
      if (step['abort_unless'] === undefined) {
        errors.push(`Step '${stepName}': execution: guard requires 'abort_unless'`);
      }
    }

    // abort_unless and abort_message are only valid on execution: guard steps.
    if (step['abort_unless'] !== undefined && step['execution'] !== 'guard') {
      errors.push(`Step '${stepName}': 'abort_unless' is only valid on execution: guard steps`);
    }
    if (step['abort_message'] !== undefined && step['execution'] !== 'guard') {
      errors.push(`Step '${stepName}': 'abort_message' is only valid on execution: guard steps`);
    }

    // agent_profile is only valid on agent steps.
    if ('agent_profile' in step && step['execution'] !== 'agent') {
      errors.push(`Step '${stepName}': 'agent_profile' is only valid on execution: agent steps`);
    }

    // output_schema is only valid on execution: agent steps.
    if (step['output_schema'] !== undefined && step['execution'] !== 'agent') {
      errors.push(`Step '${stepName}': 'output_schema' is only valid on execution: agent steps`);
    }

    // trace_schema is only valid on execution: agent steps.
    if (step['trace_schema'] !== undefined && step['execution'] !== 'agent') {
      errors.push(`Step '${stepName}': 'trace_schema' is only valid on execution: agent steps`);
    }

    // trace_validation_mode is only valid on execution: agent steps.
    if (step['trace_validation_mode'] !== undefined && step['execution'] !== 'agent') {
      errors.push(
        `Step '${stepName}': 'trace_validation_mode' is only valid on execution: agent steps`,
      );
    }

    // trace_validation_mode must be 'warn' or 'enforce' when provided.
    if (
      step['trace_validation_mode'] !== undefined &&
      step['trace_validation_mode'] !== 'warn' &&
      step['trace_validation_mode'] !== 'enforce'
    ) {
      errors.push(
        `Step '${stepName}': invalid trace_validation_mode '${String(step['trace_validation_mode'])}'; must be 'warn' or 'enforce'`,
      );
    }

    if ('uses_service' in step && typeof step['uses_service'] === 'string') {
      const services = doc['services'];
      if (
        typeof services !== 'object' ||
        services === null ||
        !(step['uses_service'] in (services as Record<string, unknown>))
      ) {
        errors.push(
          `Step '${stepName}': uses_service '${step['uses_service']}' is not defined in 'services'`,
        );
      }
    }

    // Validate retry: backoff must be a recognised value when present.
    if (step['retry'] !== undefined) {
      if (typeof step['retry'] !== 'object' || step['retry'] === null) {
        errors.push(`Step '${stepName}': 'retry' must be an object`);
      } else {
        const retry = step['retry'] as Record<string, unknown>;
        if (
          'backoff' in retry &&
          retry['backoff'] !== 'fixed' &&
          retry['backoff'] !== 'linear' &&
          retry['backoff'] !== 'exponential'
        ) {
          errors.push(
            `Step '${stepName}': 'retry.backoff' must be 'fixed', 'linear', or 'exponential'`,
          );
        }
        if (
          'max_attempts' in retry &&
          (!Number.isInteger(retry['max_attempts']) || (retry['max_attempts'] as number) < 1)
        ) {
          errors.push(`Step '${stepName}': 'retry.max_attempts' must be a positive integer`);
        }
        if (
          'base_delay_ms' in retry &&
          (typeof retry['base_delay_ms'] !== 'number' || (retry['base_delay_ms'] as number) < 0)
        ) {
          errors.push(`Step '${stepName}': 'retry.base_delay_ms' must be a non-negative number`);
        }
        if (
          'max_delay_ms' in retry &&
          (typeof retry['max_delay_ms'] !== 'number' || (retry['max_delay_ms'] as number) < 0)
        ) {
          errors.push(`Step '${stepName}': 'retry.max_delay_ms' must be a non-negative number`);
        }
      }
    }

    if ('service_method' in step && !VALID_SERVICE_METHODS.has(step['service_method'] as string)) {
      errors.push(
        `Step '${stepName}': invalid service_method '${String(step['service_method'])}'; must be 'fetch', 'create', 'update', or 'delete'`,
      );
    }

    // Validate input_map: only valid on execution: auto steps (both uses_service and handler).
    if (step['input_map'] !== undefined) {
      if (step['execution'] !== 'auto') {
        errors.push(`Step '${stepName}': 'input_map' is only valid on execution: auto steps`);
      } else {
        validateInputMapNode(
          step['input_map'] as Record<string, unknown>,
          `Step '${stepName}': input_map`,
          errors,
          0,
        );
      }
    }

    // Validate step config: literal values only (no nested objects).
    if (
      step['config'] !== undefined &&
      typeof step['config'] === 'object' &&
      step['config'] !== null
    ) {
      for (const [key, value] of Object.entries(step['config'] as Record<string, unknown>)) {
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          errors.push(
            `Step '${stepName}': config key '${key}' must be a literal value (string, number, boolean, null, or array) — nested objects are not supported in v1`,
          );
        }
      }
    }

    // Validate step config against adapter config_schema (requires registry).
    if (step['config'] !== undefined && step['uses_service'] !== undefined) {
      const serviceName = step['uses_service'] as string;
      const services = doc['services'] as Record<string, unknown> | undefined;
      const service = services?.[serviceName] as Record<string, unknown> | undefined;
      const adapterName = service?.['adapter'] as string | undefined;
      const adapter = adapterName !== undefined ? registry?.getAdapter(adapterName) : undefined;
      if (adapter !== undefined && adapter.config_schema === undefined) {
        errors.push(
          `Step '${stepName}': 'config' declared but adapter '${adapterName}' does not declare 'config_schema'`,
        );
      } else if (adapter?.config_schema !== undefined) {
        const ajv = new Ajv();
        const valid = ajv.validate(adapter.config_schema as object, step['config']);
        if (!valid) {
          const errMessages = ajv.errors?.map((e) => e.message ?? '').join('; ') ?? 'unknown error';
          errors.push(
            `Step '${stepName}': config validation failed against adapter config_schema: ${errMessages}`,
          );
        }
      }
    }

    // Validate uses_resources: each listed step ID must exist in the workflow.
    if (step['handler'] !== undefined && registry !== undefined) {
      const handlerName = step['handler'] as string;
      const handler = registry.getHandler(handlerName);
      if (handler !== undefined && handler.uses_resources !== undefined) {
        for (const resourceStepId of handler.uses_resources) {
          if (!(resourceStepId in stepsRaw)) {
            errors.push(
              `Step '${stepName}': handler '${handlerName}' declares uses_resources '${resourceStepId}' ` +
                `but no step with that ID exists in this workflow`,
            );
          }
        }
      }
    }

    // Validate trigger_rule.
    if ('trigger_rule' in step) {
      if (!VALID_TRIGGER_RULES.has(step['trigger_rule'] as TriggerRule)) {
        errors.push(
          `Step '${stepName}': invalid trigger_rule '${String(step['trigger_rule'])}'; must be one of ${[...VALID_TRIGGER_RULES].join(', ')}`,
        );
      }
    }

    // Validate depends_on: must be an array of existing step names.
    if ('depends_on' in step && step['depends_on'] !== undefined) {
      if (!Array.isArray(step['depends_on'])) {
        errors.push(`Step '${stepName}': 'depends_on' must be an array`);
      } else {
        for (const dep of step['depends_on'] as unknown[]) {
          if (typeof dep !== 'string') {
            errors.push(`Step '${stepName}': depends_on entries must be strings`);
          } else if (dep === stepName) {
            errors.push(`Step '${stepName}': a step cannot depend on itself`);
          } else if (!(dep in stepsRaw)) {
            errors.push(`Step '${stepName}': depends_on references unknown step '${dep}'`);
          }
        }
      }
    }

    // Validate when: must be a non-empty string.
    if ('when' in step && step['when'] !== undefined) {
      if (typeof step['when'] !== 'string' || step['when'].trim() === '') {
        errors.push(`Step '${stepName}': 'when' must be a non-empty string`);
      }
    }

    // Validate tools: only valid on execution: agent steps without handler.
    if (
      step['tools'] !== undefined &&
      (step['execution'] !== 'agent' || step['handler'] !== undefined)
    ) {
      errors.push(
        `Step '${stepName}': 'tools' is only valid on execution: agent steps without 'handler' defined`,
      );
    }

    // Validate tools: requires input_schema.
    if (step['tools'] !== undefined && step['input_schema'] === undefined) {
      errors.push(
        `Step '${stepName}': 'tools' requires 'input_schema' to be defined — the agentic loop needs a schema for final output extraction`,
      );
    }

    // Validate tools: entries must be in server_id:tool_name format.
    if (step['tools'] !== undefined && Array.isArray(step['tools'])) {
      for (const entry of step['tools'] as string[]) {
        if (!/^[^:]+:[^:]+$/.test(entry)) {
          errors.push(
            `Step '${stepName}': tools entry '${entry}' must be in 'server_id:tool_name' format`,
          );
        }
      }
    }

    // Validate tools: server_id must reference a defined mcp_server.
    if (
      step['tools'] !== undefined &&
      Array.isArray(step['tools']) &&
      Array.isArray(doc['mcp_servers'])
    ) {
      const serverIds = new Set((doc['mcp_servers'] as Array<{ id: string }>).map((s) => s.id));
      for (const entry of step['tools'] as string[]) {
        const serverId = entry.split(':')[0] ?? '';
        if (!serverIds.has(serverId)) {
          errors.push(
            `Step '${stepName}': tools entry '${entry}' references unknown MCP server '${serverId}'`,
          );
        }
      }
    }

    // Validate max_tool_calls: must be a positive integer.
    if (
      step['max_tool_calls'] !== undefined &&
      (!Number.isInteger(step['max_tool_calls']) || (step['max_tool_calls'] as number) <= 0)
    ) {
      errors.push(`Step '${stepName}': 'max_tool_calls' must be a positive integer`);
    }

    // Validate max_fan_out: must be a positive integer.
    if (
      step['max_fan_out'] !== undefined &&
      (!Number.isInteger(step['max_fan_out']) || (step['max_fan_out'] as number) <= 0)
    ) {
      errors.push(`Step '${stepName}': 'max_fan_out' must be a positive integer`);
    }

    // Validate tool_timeout: must be a positive integer.
    if (
      step['tool_timeout'] !== undefined &&
      (!Number.isInteger(step['tool_timeout']) || (step['tool_timeout'] as number) <= 0)
    ) {
      errors.push(`Step '${stepName}': 'tool_timeout' must be a positive integer`);
    }
  }

  // Validate mcp_servers: ids must be unique (workflow-level check).
  if (Array.isArray(doc['mcp_servers'])) {
    const seen = new Set<string>();
    for (const server of doc['mcp_servers'] as Array<{ id: string }>) {
      if (seen.has(server.id)) {
        errors.push(`mcp_servers: duplicate server id '${server.id}'`);
      }
      seen.add(server.id);
    }
  }

  // Validate services: rate_limit fields.
  if (typeof doc['services'] === 'object' && doc['services'] !== null) {
    for (const [serviceName, serviceRaw] of Object.entries(
      doc['services'] as Record<string, unknown>,
    )) {
      if (typeof serviceRaw !== 'object' || serviceRaw === null) continue;
      const service = serviceRaw as Record<string, unknown>;
      const rateLimit = service['rate_limit'];
      if (rateLimit === undefined) continue;
      if (typeof rateLimit !== 'object' || rateLimit === null) {
        errors.push(`Service '${serviceName}': 'rate_limit' must be an object`);
        continue;
      }
      const rl = rateLimit as Record<string, unknown>;

      if (
        'requests_per_second' in rl &&
        (!Number.isInteger(rl['requests_per_second']) || (rl['requests_per_second'] as number) < 1)
      ) {
        errors.push(
          `Service '${serviceName}': 'rate_limit.requests_per_second' must be a positive integer (≥ 1)`,
        );
      }
      if ('burst' in rl) {
        if (!Number.isInteger(rl['burst']) || (rl['burst'] as number) < 1) {
          errors.push(
            `Service '${serviceName}': 'rate_limit.burst' must be a positive integer (≥ 1)`,
          );
        }
        if (!('requests_per_second' in rl)) {
          errors.push(
            `Service '${serviceName}': 'rate_limit.burst' requires 'rate_limit.requests_per_second' to be set`,
          );
        }
      }
      if (
        'fallback_retry_seconds' in rl &&
        (typeof rl['fallback_retry_seconds'] !== 'number' ||
          (rl['fallback_retry_seconds'] as number) <= 0)
      ) {
        errors.push(
          `Service '${serviceName}': 'rate_limit.fallback_retry_seconds' must be a positive number (> 0)`,
        );
      }
      if (
        'min_retry_seconds' in rl &&
        (typeof rl['min_retry_seconds'] !== 'number' || (rl['min_retry_seconds'] as number) <= 0)
      ) {
        errors.push(
          `Service '${serviceName}': 'rate_limit.min_retry_seconds' must be a positive number (> 0)`,
        );
      }
      if (
        'max_retry_seconds' in rl &&
        (!Number.isInteger(rl['max_retry_seconds']) || (rl['max_retry_seconds'] as number) < 1)
      ) {
        errors.push(
          `Service '${serviceName}': 'rate_limit.max_retry_seconds' must be a positive integer (≥ 1)`,
        );
      }
    }
  }

  // Step 3b: Trigger block validation (schema-driven — see trigger-schema.ts)
  const triggerRaw = doc['trigger'];
  if (triggerRaw !== undefined) {
    normalizeTriggerFilter(triggerRaw); // canonicalise shorthand BEFORE validation
    errors.push(...validateTriggerStructure(triggerRaw));
  }

  if (errors.length > 0) {
    throw new WorkflowError(`Invalid workflow: ${errors.join('; ')}`, {
      code: 'VALIDATION_WORKFLOW_SCHEMA',
      category: 'VALIDATION',
      agentAction: 'report_to_user',
      retryable: false,
    });
  }

  // Trigger advisory warnings — only reached when the trigger validated cleanly.
  if (triggerRaw !== undefined) {
    emitTriggerWarnings(triggerRaw, String(doc['id']));
  }

  // Step 4: Stamp schema version and return typed result
  const definition = doc as unknown as WorkflowDefinition;
  definition.schema_version = CURRENT_WORKFLOW_SCHEMA_VERSION;
  return definition;
}

/** Returns true if any step in the raw steps map declares use_template. */
function hasUseTemplateInSteps(steps: unknown): boolean {
  if (typeof steps !== 'object' || steps === null) return false;
  return Object.values(steps as Record<string, unknown>).some(
    (s) => typeof s === 'object' && s !== null && 'use_template' in (s as object),
  );
}

/**
 * Recursively validates an input_map node tree.
 * Every object node must have at least one key.
 * Every leaf must be a non-empty string.
 * Maximum depth is 10.
 */
function validateInputMapNode(
  node: unknown,
  pathDesc: string,
  errors: string[],
  depth: number,
): void {
  if (depth > 10) {
    errors.push(`${pathDesc}: exceeded maximum nesting depth of 10`);
    return;
  }
  if (typeof node === 'string') {
    if (node.trim() === '') {
      errors.push(`${pathDesc}: source path must be a non-empty string`);
    }
    return;
  }
  if (typeof node === 'object' && node !== null && !Array.isArray(node)) {
    const obj = node as Record<string, unknown>;

    // Literal sentinel node.
    if ('$literal' in obj) {
      if (Object.keys(obj).length !== 1) {
        errors.push(
          `${pathDesc}: $literal node must have exactly one key ($literal); found sibling keys`,
        );
        return;
      }
      const val = obj['$literal'];
      const allowed = ['string', 'number', 'boolean'];
      if (val !== null && !allowed.includes(typeof val)) {
        errors.push(`${pathDesc}: $literal value must be a string, number, boolean, or null`);
      }
      return;
    }

    // Nested object — recurse.
    const entries = Object.entries(obj);
    if (entries.length === 0) {
      errors.push(`${pathDesc}: object nodes must have at least one key`);
      return;
    }
    for (const [key, child] of entries) {
      validateInputMapNode(child, `${pathDesc} path "${key}"`, errors, depth + 1);
    }
    return;
  }
  // null, number, boolean, array
  errors.push(
    `${pathDesc}: expected a string or object, got ${Array.isArray(node) ? 'array' : typeof node}`,
  );
}
