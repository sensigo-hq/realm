// init command — scaffolds a new workflow project directory.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { Command } from 'commander';

/**
 * Scaffolds a new workflow project at targetDir with five template files
 * (workflow.yaml, schema.json, .env.example, README.md, registry.sample.js).
 * Throws an error if targetDir already exists.
 * @param name      Workflow project name used in file contents.
 * @param targetDir Directory to create (defaults to join(cwd, name) in the command action).
 */
export async function initWorkflow(name: string, targetDir: string): Promise<void> {
  if (existsSync(targetDir)) {
    throw new Error(`Directory already exists: ${targetDir}`);
  }

  await mkdir(targetDir, { recursive: true });

  const workflowYaml = `# ${name} workflow
id: ${name}
name: "${name}"
version: 1
initial_state: created

# extensions: ./registry.js  — project extension modules (see docs/reference/project-extensions.md)

steps:
  step_one:
    description: "First step \u2014 replace with your own"
    execution: agent
    allowed_from_states: [created]
    produces_state: step_one_done
    input_schema:
      type: object
      required: [result]
      properties:
        result:
          type: string

  finalize:
    description: "Final step"
    execution: auto
    allowed_from_states: [step_one_done]
    produces_state: completed
`;

  const schemaJson = JSON.stringify(
    {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {},
      additionalProperties: true,
    },
    null,
    2,
  );

  const envExample = `# Add your secrets here
# EXAMPLE_API_KEY=your_key_here
`;

  const readmeMd = `# ${name}

A Realm workflow.

## Run

\`\`\`bash
realm workflow validate ./
realm workflow register ./
realm workflow run ./
\`\`\`

## Test

Add fixtures to \`fixtures/\` and run:

\`\`\`bash
realm workflow test ./ --fixtures ./fixtures/
\`\`\`
`;

  // Project extensions sample: the documented declarative contract shape, fully commented
  // out — nothing is registered by default. Activate by uncommenting and declaring
  // `extensions: ./registry.js` in workflow.yaml (then re-register the workflow).
  const registrySampleJs = `// registry.sample.js — project extension module template for ${name}.
// Docs: docs/reference/project-extensions.md (module contract, trust model, precedence).
//
// To use: rename to registry.js, fill in your extensions, then declare it in workflow.yaml:
//   extensions: ./registry.js
// and re-register the workflow (realm workflow register ./).
//
// The default export is a declarative object — instances keyed by REGISTRATION NAME
// (the map key is the name your workflow YAML references).

export default {
  // adapters: {
  //   my_service: {
  //     id: 'my_service',
  //     fetch: async (operation, params, config) => ({ status: 200, data: {} }),
  //     create: async (operation, params, config) => ({ status: 201, data: {} }),
  //     update: async (operation, params, config) => ({ status: 200, data: {} }),
  //   },
  // },
  // handlers: {
  //   my_handler: {
  //     id: 'my_handler',
  //     execute: async (inputs, context) => ({ data: { ok: true } }),
  //   },
  // },
  // processors: {
  //   my_processor: {
  //     id: 'my_processor',
  //     process: async (content, config) => content,
  //   },
  // },
};
`;

  await writeFile(join(targetDir, 'workflow.yaml'), workflowYaml, 'utf8');
  await writeFile(join(targetDir, 'schema.json'), schemaJson + '\n', 'utf8');
  await writeFile(join(targetDir, '.env.example'), envExample, 'utf8');
  await writeFile(join(targetDir, 'README.md'), readmeMd, 'utf8');
  await writeFile(join(targetDir, 'registry.sample.js'), registrySampleJs, 'utf8');
}

export const initCommand = new Command('init')
  .argument('<name>', 'Workflow project name (becomes the directory name)')
  .description('Scaffold a new workflow project')
  .action(async (name: string) => {
    const { join: pathJoin } = await import('node:path');
    const targetDir = pathJoin(process.cwd(), name);
    try {
      await initWorkflow(name, targetDir);
      console.log(`Created: ${name}/`);
      console.log('  workflow.yaml');
      console.log('  schema.json');
      console.log('  .env.example');
      console.log('  README.md');
      console.log('  registry.sample.js');
      console.log('');
      console.log(`Next: realm workflow validate ./${name}/`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
