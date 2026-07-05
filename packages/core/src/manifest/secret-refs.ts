// Secret-reference grammar for the deployment manifest (v0.14): `${secret:NAME}`.
//
// Pure string/tree functions — core owns the GRAMMAR only. Reading secret sources
// (dotenv files, process.env) and resolving values is the CLI's job.
//
// Grammar:
//   - a reference is exactly `${secret:NAME}` with NAME = [A-Z0-9_]+
//   - references are legal ONLY inside string values under `config` trees
//   - composite/embedded references are allowed: "${secret:A}:${secret:B}"
//   - `$$` escapes a literal `$` (so `$${secret:X}` interpolates to the literal text
//     `${secret:X}`); any other `${secret:` occurrence that does not match the full
//     grammar is MALFORMED and must be rejected loudly (typos never pass silently).

const REF_PATTERN = /^\$\{secret:([A-Z0-9_]+)\}/;

/** Result of scanning one string value for secret references. */
export interface SecretScanResult {
  /** Referenced secret NAMEs, in order of appearance (duplicates preserved). */
  refs: string[];
  /** Malformed `${secret:...}`-like fragments (bad charset, unterminated). */
  malformed: string[];
}

/**
 * Scans a string left-to-right honoring the `$$` escape. Well-formed references are
 * collected; anything starting like a reference but not matching the grammar is malformed.
 */
export function scanSecretString(value: string): SecretScanResult {
  const refs: string[] = [];
  const malformed: string[] = [];
  let i = 0;
  while (i < value.length) {
    if (value[i] === '$') {
      if (value[i + 1] === '$') {
        i += 2; // escaped literal '$'
        continue;
      }
      const rest = value.slice(i);
      const match = REF_PATTERN.exec(rest);
      if (match !== null) {
        refs.push(match[1]!);
        i += match[0].length;
        continue;
      }
      if (rest.startsWith('${secret:') || rest.startsWith('${secret')) {
        // Looks like a reference but is not one — surface the fragment for the error.
        const end = rest.indexOf('}');
        malformed.push(end === -1 ? rest.slice(0, 24) : rest.slice(0, end + 1));
        i += end === -1 ? rest.length : end + 1;
        continue;
      }
    }
    i += 1;
  }
  return { refs, malformed };
}

/** True when the string contains at least one well-formed secret reference. */
export function stringHasSecretRefs(value: string): boolean {
  return scanSecretString(value).refs.length > 0;
}

/**
 * Interpolates a string: well-formed references are replaced via `resolve(name)`,
 * `$$` becomes a literal `$`. The caller guarantees every referenced name resolves
 * (the CLI aggregates unresolved references into one loud error BEFORE interpolating).
 */
export function interpolateSecretString(value: string, resolve: (name: string) => string): string {
  let out = '';
  let i = 0;
  while (i < value.length) {
    if (value[i] === '$') {
      if (value[i + 1] === '$') {
        out += '$';
        i += 2;
        continue;
      }
      const match = REF_PATTERN.exec(value.slice(i));
      if (match !== null) {
        out += resolve(match[1]!);
        i += match[0].length;
        continue;
      }
    }
    out += value[i];
    i += 1;
  }
  return out;
}

/** One secret reference found in a config tree, with its binding site for error messages. */
export interface SecretRefSite {
  /** Referenced secret NAME. */
  name: string;
  /** Dot-path binding site, e.g. `adapters.github.config.auth.token`. */
  path: string;
}

/**
 * Walks a config tree (objects/arrays/strings) collecting every well-formed secret
 * reference with its binding site. Malformed fragments are collected separately.
 */
export function findSecretRefSites(
  node: unknown,
  basePath: string,
): { sites: SecretRefSite[]; malformed: Array<{ path: string; fragment: string }> } {
  const sites: SecretRefSite[] = [];
  const malformed: Array<{ path: string; fragment: string }> = [];
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      const scan = scanSecretString(value);
      for (const name of scan.refs) sites.push({ name, path });
      for (const fragment of scan.malformed) malformed.push({ path, fragment });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, idx) => walk(item, `${path}[${idx}]`));
      return;
    }
    if (typeof value === 'object' && value !== null) {
      for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
    }
  };
  walk(node, basePath);
  return { sites, malformed };
}

/**
 * Interpolates every string inside a config tree, returning a deep copy.
 * Non-string leaves pass through untouched.
 */
export function interpolateConfigTree<T>(node: T, resolve: (name: string) => string): T {
  if (typeof node === 'string') {
    return interpolateSecretString(node, resolve) as unknown as T;
  }
  if (Array.isArray(node)) {
    return node.map((item) => interpolateConfigTree(item, resolve)) as unknown as T;
  }
  if (typeof node === 'object' && node !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      out[key] = interpolateConfigTree(child, resolve);
    }
    return out as unknown as T;
  }
  return node;
}
