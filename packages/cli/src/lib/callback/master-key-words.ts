// master-key-words.ts — callback K2b (R1.3): what a command source that gave no master key is told,
// as a reason and a closing sentence. Its own file, so every command that resolves the master key
// says the same words (`realm callback key` and `realm listen`'s start lines; `realm listen` cannot
// import that command's file). Callback C2c moved the key command's other master key sentences here:
// an invalid source of any kind, the clash of a setting with `encryption.key`, and the warning that a
// master key file is open to other users.
import { isAbsolute } from 'node:path';
import { shellWord } from '@sensigo/realm';
import { COMMAND_TIMEOUT_SECONDS } from './master-key-command.js';
import type { MasterKeyResolution, MasterKeySource } from './master-key.js';

/**
 * A word a person typed, as a printed command carries it: through `shellWord`, and quoted when it
 * would end the line in a full stop (`n8n.example.com.` is its own host, and a closing dot reads as
 * the sentence's).
 */
export function typedWord(value: string): string {
  const word = shellWord(value);
  return word.endsWith('.') && !word.startsWith("'") ? `'${value}'` : word;
}

/**
 * An invalid master key source, as a clause (`head`) and the sentences that close it (`closing`; the
 * first is the one `realm listen` keeps: a new master key would leave the stored keys unreadable).
 * `homeFile` is `<home>/encryption.key`; `env` says whether a named file's path was relative.
 */
export function invalidMasterKeyWords(
  res: Extract<MasterKeyResolution, { state: 'invalid' }>,
  env: Readonly<Record<string, string | undefined>>,
  homeFile: string,
): { readonly head: string; readonly closing: readonly string[] } {
  if (res.source === 'command') {
    const { reason, tail } = commandSourceWords(res);
    return {
      head: `REALM_ENCRYPTION_KEY_COMMAND did not give a master key: ${reason}`,
      closing: [tail],
    };
  }
  const named = env['REALM_ENCRYPTION_KEY_FILE'];
  const reason =
    res.source === 'env_file' && named !== undefined && !isAbsolute(named)
      ? 'its path is not absolute'
      : res.reason === 'empty'
        ? 'it is empty'
        : res.reason === 'unreadable_file'
          ? 'it cannot be read'
          : 'it is not 64 hexadecimal characters';
  const subject =
    res.source === 'env'
      ? 'REALM_ENCRYPTION_KEY'
      : res.source === 'env_file'
        ? 'the file REALM_ENCRYPTION_KEY_FILE names'
        : homeFile;
  return {
    head: `${subject} is not a master key: ${reason}`,
    closing: ['A master key is 64 hexadecimal characters.', 'Make one with: openssl rand -hex 32'],
  };
}

/** The clause that a setting and `encryption.key` hold different master keys (no full stop). */
export function masterKeyClash(
  source: MasterKeySource,
  fp: string,
  homeFile: string,
  homeFp: string,
): string {
  const setting =
    source === 'env'
      ? 'REALM_ENCRYPTION_KEY'
      : source === 'command'
        ? 'REALM_ENCRYPTION_KEY_COMMAND'
        : 'the file REALM_ENCRYPTION_KEY_FILE names';
  return `${setting} gives encryption key ${fp}, but ${homeFile} holds encryption key ${homeFp}`;
}

/** A master key file open to other users (`mode`: four octal digits), ending with the fix. */
export function masterKeyOpenWarning(path: string, mode: string): string {
  return `${path} is open to other users (mode ${mode}). Fix that with: chmod 600 ${typedWord(path)}`;
}

/** The reason (a clause) and the closing sentence for an invalid command source. */
export function commandSourceWords(res: Extract<MasterKeyResolution, { state: 'invalid' }>): {
  readonly reason: string;
  readonly tail: string;
} {
  const byHand = 'Run the command by hand to see why.';
  const value = 'Check the value of REALM_ENCRYPTION_KEY_COMMAND.';
  // Not "make one with openssl": a new key in the vault would leave every stored key unreadable.
  const output =
    'The command must print the master key, 64 hexadecimal characters, and nothing else.';
  switch (res.reason) {
    case 'command_failed':
      return {
        reason:
          res.signal !== undefined
            ? `its command was ended by ${res.signal}`
            : `its command exited with status ${String(res.status)}`,
        tail: byHand,
      };
    case 'command_timeout':
      return {
        reason: `its command took longer than ${COMMAND_TIMEOUT_SECONDS} seconds`,
        tail: byHand,
      };
    case 'command_not_started':
      return {
        reason: `its command could not be started (${res.code ?? 'unknown error'})`,
        tail: byHand,
      };
    case 'command_unclosed_quote':
      return { reason: 'its value has an unclosed quote', tail: value };
    case 'command_no_program':
      return { reason: 'its value names no program', tail: value };
    case 'empty':
      return { reason: 'its output is empty', tail: output };
    case 'malformed':
      return { reason: 'its output is not 64 hexadecimal characters', tail: output };
    case 'unreadable_file':
      // A command source reads no file.
      throw new Error('a command source has no unreadable file');
  }
}
