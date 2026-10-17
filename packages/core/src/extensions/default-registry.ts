// default-registry.ts — pre-populates ExtensionRegistry with Realm's config-less built-ins.
// Used by the execution engine as the fallback when no registry is explicitly provided.
//
// Since v0.14.0 the default registry contains, of adapters, ONLY the filesystem one: every adapter
// that needs configuration or credentials (slack, github, gorgias, …) is constructed from
// the deployment manifest (`<deployment root>/realm.yaml`) via the CLI loader's built-in
// catalog — the previous env-read SlackAdapter registration (SLACK_WEBHOOK_URL) is gone.
// Issue #760 adds the one config-less built-in handler, `check_quotes`.
import { ExtensionRegistry } from './registry.js';
import { FileSystemAdapter } from '../adapters/file-adapter.js';
import { CheckQuotesHandler } from '../handlers/check-quotes.js';

/**
 * Returns an ExtensionRegistry pre-populated with Realm's config-less built-ins: the adapter
 * `FileSystemAdapter` under `'filesystem'` and the handler `CheckQuotesHandler` under
 * `'check_quotes'`. Nothing here reads the environment.
 *
 * Configured adapters (slack, github, …) come from the deployment manifest — declare
 * them under `adapters:` in realm.yaml and the CLI loader constructs them with their
 * secret-resolved config. Library consumers composing registries by hand can still
 * `registry.register(...)` their own instances on top of this.
 */
export function createDefaultRegistry(): ExtensionRegistry {
  const r = new ExtensionRegistry();
  r.register('adapter', 'filesystem', new FileSystemAdapter('filesystem'));
  r.register('handler', 'check_quotes', new CheckQuotesHandler());
  return r;
}
