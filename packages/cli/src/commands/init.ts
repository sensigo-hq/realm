// init command — scaffolds a new workflow project directory.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { Command } from 'commander';
import { findTrustRoot, shellWord } from '@sensigo/realm';
import { writerCtx } from '../output/writer.js';

/** What `initWorkflow` did (#878). */
export interface InitResult {
  /** The files written into targetDir, in the order written. */
  files: readonly string[];
  /** Set when targetDir lies inside a project: the project's top folder (core's findTrustRoot)
   *  and whether it already holds a realm.yaml. Absent when targetDir is its own project. */
  project?: { root: string; hasManifest: boolean };
}

/**
 * Scaffolds a new workflow project at targetDir with six template files
 * (workflow.yaml, schema.json, .env.example, README.md, registry.sample.js, realm.yaml).
 * Inside a project — a folder above targetDir holds a package.json or a .git (core's
 * findTrustRoot, the folder the loader reads realm.yaml from) — it writes four: realm.yaml and
 * .env.example belong in the project's top folder, and nothing is written or changed there (#878).
 * Throws an error if targetDir already exists.
 * @param name      Workflow project name used in file contents.
 * @param targetDir Directory to create (defaults to join(cwd, name) in the command action).
 */
export async function initWorkflow(name: string, targetDir: string): Promise<InitResult> {
  if (existsSync(targetDir)) {
    throw new Error(`Directory already exists: ${targetDir}`);
  }

  await mkdir(targetDir, { recursive: true });
  // #878: the new folder holds neither a package.json nor a .git, so it is its own project
  // exactly when no folder above it holds one — the loader anchors realm.yaml with this function.
  const root = findTrustRoot(targetDir);
  const ownProject = root === targetDir;

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
      additionalProperties: false
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

  const files: string[] = [];
  const write = async (file: string, text: string): Promise<void> => {
    await writeFile(join(targetDir, file), text, 'utf8');
    files.push(file);
  };
  await write('workflow.yaml', workflowYaml);
  await write('schema.json', schemaJson + '\n');
  if (ownProject) await write('.env.example', envExample);
  await write('README.md', readmeMd);
  await write('registry.sample.js', registrySampleJs);
  if (ownProject) await write('realm.yaml', realmYaml);
  if (ownProject) return { files };
  return { files, project: { root, hasManifest: existsSync(join(root, 'realm.yaml')) } };
}

export const initCommand = new Command('init')
  .argument('<name>', 'Workflow project name (becomes the directory name)')
  .description('Scaffold a new workflow project')
  .action(async (name: string) => {
    const { join: pathJoin } = await import('node:path');
    const targetDir = pathJoin(process.cwd(), name);
    try {
      const result = await initWorkflow(name, targetDir);
      console.log(`Created: ${name}/`);
      for (const file of result.files) console.log(`  ${file}`);
      console.log('');
      if (result.project !== undefined) {
        // #878: the project's folder is a fact the reader acts on, so it prints whole, a path under
        // HOME included — the shipped rule for a manifest's path (H-10, writer.ts).
        const { root, hasManifest } = result.project;
        console.log(
          `${name}/ is inside the project '${writerCtx().cmd(root)}', which holds a package.json or a .git.`,
        );
        console.log(
          'Realm reads realm.yaml only from that folder, so it and .env.example were not written here.',
        );
        console.log(
          hasManifest
            ? "The project's realm.yaml applies to this workflow."
            : 'The project has no realm.yaml yet: add one there when a workflow needs settings — how an adapter, handler or processor is built, its secrets, or a gate notifier.',
        );
        console.log('');
      }
      console.log(`Next: realm workflow validate ${shellWord(`./${name}/`)}`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
