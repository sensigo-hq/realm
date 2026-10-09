/**
 * The ONE POSIX shell quoter for a value a printed command carries (issue #625 PR-2a, F6; review G5-5):
 * printed bare when it holds only `[A-Za-z0-9._/:@%+=,-]` and is not empty; otherwise single-quoted,
 * each `'` written as `'\''`; the empty value prints `''`. A command a person pastes then records
 * exactly the value it names and runs nothing the value holds (`$(…)`, `|`, `;`, a space, a quote).
 * Every printed command with a free-text value uses it — core's composers (`oneOf`, so `--from` and
 * `--choice`) and the CLI's lines (`realm agent`'s re-attach flags, `realm run abandon`'s `--params`,
 * the `--step` and `--void` lines).
 */
export function shellWord(value: string): string {
  return /^[A-Za-z0-9._/:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * A printed command set inside a sentence in prose quotes, `'realm … '` (F6): wrapped in `'…'` when it
 * holds no `'`; a command whose values {@link shellWord} quoted is printed bare, since prose quotes
 * around it would break the shell quoting a paste needs.
 */
export function quotedCommand(command: string): string {
  return command.includes("'") ? command : `'${command}'`;
}
