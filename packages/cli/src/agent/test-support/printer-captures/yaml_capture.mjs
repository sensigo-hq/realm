// yaml_capture.mjs — the YAML dumpers (js-yaml's `dump`; PyYAML's `safe_dump` through python3) over the
// FAKE values that FORCE YAML's quoting (cases.mjs `YAML_CASES`). One JSON line per (printer, case).
/* global console, process */
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import { YAML_CASES } from './cases.mjs';

const cases = Object.fromEntries(Object.entries(YAML_CASES).map(([c, [value]]) => [c, value]));
const py = `
import json, sys, yaml
cases = json.loads(sys.stdin.read())
for k, v in cases.items():
    print(json.dumps({'p': 'py.yaml_safe_dump_dict', 'c': k, 'out': yaml.safe_dump({'k': v})}))
`;
for (const [c, v] of Object.entries(cases)) {
  console.log(JSON.stringify({ p: 'node.jsyaml_dump_obj', c, out: yaml.dump({ k: v }) }));
}
process.stdout.write(
  execFileSync('python3', ['-c', py], { input: JSON.stringify(cases) }).toString(),
);
