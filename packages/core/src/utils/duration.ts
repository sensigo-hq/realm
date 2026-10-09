/**
 * The ONE duration formatter for the lines that say how long ago, or how late, something was
 * (issue #625 PR-2a, F1): under one minute `<n>s` — never `0m`, which reads as "no time at all" —;
 * then `<m>m`, `<h>h <m>m` and `<d>d <h>h`. A negative duration reads as `0s`. The expiry line
 * (`expiryCarriedOutLine`) and `realm run drain` use it. Three older formatters are not yet this
 * one: `formatGateAge` (the CLI's `list` and `inspect`), `run-health.ts`'s coarse `formatAgo`, and
 * the Slack reminder's minutes.
 */
export function formatDuration(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < 60_000) return `${Math.floor(clamped / 1000)}s`;
  const totalMinutes = Math.floor(clamped / 60_000);
  const totalHours = Math.floor(totalMinutes / 60);
  const totalDays = Math.floor(totalHours / 24);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  if (totalHours < 24) return `${totalHours}h ${totalMinutes % 60}m`;
  return `${totalDays}d ${totalHours % 24}h`;
}
