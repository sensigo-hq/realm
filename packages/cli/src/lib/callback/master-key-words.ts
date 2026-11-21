// master-key-words.ts — callback K2b (R1.3): what a command source that gave no master key is told,
// as a reason and a closing sentence. Its own file, so every command that resolves the master key
// says the same words (`realm callback key` now; `realm listen` cannot import that command's file).
import { COMMAND_TIMEOUT_SECONDS } from './master-key-command.js';
import type { MasterKeyResolution } from './master-key.js';

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
