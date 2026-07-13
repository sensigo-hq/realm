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

# extensions: ./registry.js  — project extension modules (see docs/reference/project-extensions.md)

# Steps are sequenced by 'depends_on' (the DAG) — the only sequencing model.
steps:
  step_one:
    description: "First step \u2014 replace with your own"
    execution: agent
    input_schema:
      type: object
      required: [result]
      properties:
        result:
          type: string

  step_two:
    description: "Second step"
    execution: auto
    depends_on: [step_one]
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

  const envExample = `# Secret values referenced by realm.yaml (\${secret:NAME} bindings).
# This file is the default 'dotenv' secret source — see docs/reference/deployment-manifest.md
# EXAMPLE_API_KEY=your_key_here
`;

  const realmYaml = `# realm.yaml — deployment manifest for this project (see docs/reference/deployment-manifest.md).
# The manifest owns deployment CONFIG: adapter construction, secret bindings
# (\${secret:NAME}), handler/processor config, and gate-notifier config.
# Workflows keep declaring CODE via 'extensions:' in workflow.yaml.
version: 1

# secrets:
#   sources: [dotenv]        # dotenv | env; default [dotenv]; order = precedence
#   dotenv: ./.env           # default: .env next to this file

# adapters:
#   github:
#     use: github            # built-in catalog name, or ./dist/registry.js#myFactory
#     config: { auth: { token: "\${secret:GITHUB_TOKEN}" } }

# handlers:
#   my_handler:
#     use: ./registry.js#myHandlerFactory
#     config: { api_key: "\${secret:MY_API_KEY}" }

# notifiers:
#   slack_gate:
#     type: slack
#     config:
#       webhook_url: "\${secret:SLACK_WEBHOOK_URL}"
#       bot_token: "\${secret:SLACK_BOT_TOKEN}"
#       channel_id: C0XXXX
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
  const registrySampleJs = `// registry.sample.js — extension module template for ${name}.
// Docs: docs/reference/project-extensions.md (code) + docs/reference/deployment-manifest.md (config).
//
// TWO export shapes:
//  1. The workflow-declared DEFAULT export ('extensions:' in workflow.yaml) — a declarative
//     object of ready instances (no config, no secrets — code only).
//  2. Named FACTORY exports for realm.yaml 'use:' refs — (ctx: { id, config }) => instance,
//     where config arrives with \${secret:NAME} references already resolved.

// export function myAdapterFactory({ id, config }) {
//   return {
//     id,
//     fetch: async (operation, params, cfg) => ({ status: 200, data: {} }),
//     create: async (operation, params, cfg) => ({ status: 201, data: {} }),
//     update: async (operation, params, cfg) => ({ status: 200, data: {} }),
//   };
// }

// export function myHandlerFactory({ id, config }) {
//   return { id, execute: async (inputs, context) => ({ data: { ok: true } }) };
// }

export default {
  // adapters: { my_adapter: /* ready instance */ },
  // handlers: { my_handler: /* ready instance */ },
  // processors: { my_processor: /* ready instance */ },
};
`;

  await writeFile(join(targetDir, 'workflow.yaml'), workflowYaml, 'utf8');
  await writeFile(join(targetDir, 'schema.json'), schemaJson + '\n', 'utf8');
  await writeFile(join(targetDir, '.env.example'), envExample, 'utf8');
  await writeFile(join(targetDir, 'README.md'), readmeMd, 'utf8');
  await writeFile(join(targetDir, 'registry.sample.js'), registrySampleJs, 'utf8');
  await writeFile(join(targetDir, 'realm.yaml'), realmYaml, 'utf8');
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
      console.log('  realm.yaml');
      console.log('');
      console.log(`Next: realm workflow validate ./${name}/`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
