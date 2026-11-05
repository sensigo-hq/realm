// realm-home.ts — issue #616 PR-2a, unit (i): the one place that says where realm's home is. The home
// is `~/.realm`; every store's default folder is under it. This module is the only place in realm's
// source that asks the system for the user's home (a source scan keeps it so: realm-home.test.ts), and
// it asks at every call, never at import (the #285 lesson: a value captured at import ignores a HOME
// set later). A home that cannot be used is refused with `STATE_HOME_UNUSABLE` before any store opens
// anything, so a command never keeps its runs in a `.realm` folder under the current directory.
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { WorkflowError } from '../types/workflow-error.js';

const REMEDY = 'Set HOME to your home directory and run the command again.';

function unusable(message: string): WorkflowError {
  return new WorkflowError(message, {
    code: 'STATE_HOME_UNUSABLE',
    category: 'STATE',
    agentAction: 'report_to_user',
    retryable: false,
  });
}

/**
 * Realm's home: `~/.realm`, from the user's home as the system answers it now. A `home` given by a
 * program is used as given, when it is an absolute path.
 *
 * Refused with `STATE_HOME_UNUSABLE` (nothing is read from the disk, nothing is created):
 * - the system answers an empty home (`HOME` set but empty), or has none to give (no `HOME` and no
 *   account entry, as for a container run as an unknown user id);
 * - the system answers a home that is not an absolute path (`HOME=rel`, `HOME=~`, a blank) — the
 *   message never shows the value;
 * - a program passes a `home` that is not an absolute path — the message names that argument.
 *
 * A home that does not exist, or is not a folder, is returned as it is: the stores create their
 * folders, or refuse, as they always have.
 */
export function realmHomePath(home?: string): string {
  if (home !== undefined) {
    if (!isAbsolute(home)) throw unusable(`the home must be an absolute path, got '${home}'`);
    return home;
  }
  let system: string;
  try {
    system = homedir();
  } catch {
    // Node throws ERR_SYSTEM_ERROR (uv_os_homedir ENOENT) when there is no HOME and no account entry.
    system = '';
  }
  // The empty test comes first: an empty string is not absolute either, and keeps its own words.
  if (system === '') {
    throw unusable(
      `no home directory: HOME is empty or unset and this account has no home, so realm cannot find ~/.realm. ${REMEDY}`,
    );
  }
  if (!isAbsolute(system)) {
    throw unusable(
      `no home directory: HOME is not an absolute path, so realm cannot find ~/.realm. ${REMEDY}`,
    );
  }
  return join(system, '.realm');
}
