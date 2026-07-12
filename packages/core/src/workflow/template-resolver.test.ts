import { describe, it, expect } from 'vitest';
import {
  resolvePlaceholders,
  resolveObject,
  expandTemplateInstantiation,
  resolveTemplates,
} from './template-resolver.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { TemplateDefinition, StepDefinition } from '../types/workflow-definition.js';

// --- resolvePlaceholders ---

describe('resolvePlaceholders', () => {
  it('replaces known placeholders with their values', () => {
    expect(resolvePlaceholders('{{ prefix }}_done', { prefix: 'invoice' })).toBe('invoice_done');
  });

  it('leaves unknown placeholders as-is', () => {
    expect(resolvePlaceholders('{{ unknown }} value', { prefix: 'x' })).toBe('{{ unknown }} value');
  });

  it('replaces multiple placeholders in one string', () => {
    const result = resolvePlaceholders('{{ prefix }}_{{ step }}', {
      prefix: 'inv',
      step: 'extract',
    });
    expect(result).toBe('inv_extract');
  });
});

// --- resolveObject ---

describe('resolveObject', () => {
  it('replaces placeholders in a string value', () => {
    expect(resolveObject('{{ prefix }}_done', { prefix: 'doc' })).toBe('doc_done');
  });

  it('recurses into nested objects', () => {
    const result = resolveObject(
      { description: '{{ label }} step', nested: { message: '{{ label }}_done' } },
      { label: 'audit' },
    );
    expect(result).toEqual({
      description: 'audit step',
      nested: { message: 'audit_done' },
    });
  });

  it('recurses into arrays', () => {
    const result = resolveObject(['{{ prefix }}_ready', '{{ prefix }}_done'], { prefix: 'inv' });
    expect(result).toEqual(['inv_ready', 'inv_done']);
  });

  it('leaves non-string leaves unchanged', () => {
    expect(resolveObject(42, {})).toBe(42);
    expect(resolveObject(true, {})).toBe(true);
    expect(resolveObject(null, {})).toBeNull();
  });
});

// --- expandTemplateInstantiation ---

const THREE_STEP_TEMPLATE: TemplateDefinition = {
  params: {
    service_name: { required: true },
    agent_description: { default: 'Review the content.' },
  },
  steps: {
    extract: {
      description: 'Extract from {{ service_name }}',
      execution: 'auto',
      uses_service: '{{ service_name }}',
      operation: 'read',
      instructions: '{{ prefix }}_ready',
      display: '{{ prefix }}_extracted',
    } as StepDefinition,
    review: {
      description: '{{ agent_description }}',
      execution: 'agent',
      instructions: '{{ prefix }}_extracted',
      display: '{{ prefix }}_reviewed',
    } as StepDefinition,
    record: {
      description: 'Record the result',
      execution: 'auto',
      instructions: '{{ prefix }}_reviewed',
      display: '{{ prefix }}_done',
    } as StepDefinition,
  },
};

describe('expandTemplateInstantiation', () => {
  it('happy path: expands 3-step template with correct IDs and resolved values', () => {
    const expanded = expandTemplateInstantiation(
      'invoice_check',
      {
        use_template: 'my_template',
        prefix: 'invoice',
        params: { service_name: 'invoices', agent_description: 'Review the invoice.' },
      },
      { my_template: THREE_STEP_TEMPLATE },
    );

    expect(expanded).toHaveLength(3);
    const [id0, step0] = expanded[0]!;
    const [id1, step1] = expanded[1]!;
    const [id2, step2] = expanded[2]!;

    expect(id0).toBe('invoice_extract');
    expect(step0.description).toBe('Extract from invoices');
    expect(step0.uses_service).toBe('invoices');
    expect(step0.instructions).toBe('invoice_ready');
    expect(step0.display).toBe('invoice_extracted');

    expect(id1).toBe('invoice_review');
    expect(step1.description).toBe('Review the invoice.');

    expect(id2).toBe('invoice_record');
    expect(step2.display).toBe('invoice_done');
  });

  it('uses default param value when caller does not supply it', () => {
    const expanded = expandTemplateInstantiation(
      'doc_check',
      {
        use_template: 'my_template',
        prefix: 'doc',
        params: { service_name: 'docs' },
      },
      { my_template: THREE_STEP_TEMPLATE },
    );
    const [, step1] = expanded[1]!;
    expect(step1.description).toBe('Review the content.');
  });

  it('throws WorkflowError when a required param is missing', () => {
    expect(() =>
      expandTemplateInstantiation(
        'doc_check',
        { use_template: 'my_template', prefix: 'doc', params: {} },
        { my_template: THREE_STEP_TEMPLATE },
      ),
    ).toThrow(WorkflowError);

    try {
      expandTemplateInstantiation(
        'doc_check',
        { use_template: 'my_template', prefix: 'doc', params: {} },
        { my_template: THREE_STEP_TEMPLATE },
      );
    } catch (err) {
      expect((err as WorkflowError).message).toContain('service_name');
    }
  });

  it('throws WorkflowError when template name is unknown', () => {
    expect(() =>
      expandTemplateInstantiation('some_key', { use_template: 'nonexistent', prefix: 'x' }, {}),
    ).toThrow(WorkflowError);

    try {
      expandTemplateInstantiation('some_key', { use_template: 'nonexistent', prefix: 'x' }, {});
    } catch (err) {
      expect((err as WorkflowError).message).toContain("unknown template 'nonexistent'");
    }
  });

  it('throws WorkflowError when prefix is missing', () => {
    expect(() =>
      expandTemplateInstantiation(
        'some_key',
        { use_template: 'my_template' },
        { my_template: THREE_STEP_TEMPLATE },
      ),
    ).toThrow(WorkflowError);

    try {
      expandTemplateInstantiation(
        'some_key',
        { use_template: 'my_template' },
        { my_template: THREE_STEP_TEMPLATE },
      );
    } catch (err) {
      expect((err as WorkflowError).message).toContain("non-empty 'prefix'");
    }
  });
});

// --- resolveTemplates ---

describe('resolveTemplates', () => {
  const SIMPLE_TEMPLATE: TemplateDefinition = {
    params: { svc: { required: true } },
    steps: {
      fetch: {
        description: 'Fetch from {{ svc }}',
        execution: 'auto',
      } as StepDefinition,
    },
  };

  it('throws WorkflowError when expansion produces a duplicate step ID', () => {
    // Two instantiations with the same prefix would produce the same step IDs.
    const rawSteps = {
      first_call: { use_template: 't', prefix: 'inv', params: { svc: 'svc1' } },
      second_call: { use_template: 't', prefix: 'inv', params: { svc: 'svc2' } },
    };
    expect(() => resolveTemplates(rawSteps, { t: SIMPLE_TEMPLATE })).toThrow(WorkflowError);
    try {
      resolveTemplates(rawSteps, { t: SIMPLE_TEMPLATE });
    } catch (err) {
      expect((err as WorkflowError).message).toContain('duplicate step ID');
    }
  });

  it('preserves order: concrete steps and template expansions interleave correctly', () => {
    const rawSteps = {
      setup: {
        description: 'Setup step',
        execution: 'auto',
      },
      invoice_block: { use_template: 'simple', prefix: 'inv', params: { svc: 'invoices' } },
    };
    const result = resolveTemplates(rawSteps as Record<string, unknown>, {
      simple: SIMPLE_TEMPLATE,
    });
    const keys = Object.keys(result);
    expect(keys).toEqual(['setup', 'inv_fetch']);
  });
});
