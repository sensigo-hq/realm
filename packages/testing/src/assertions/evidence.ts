// Evidence assertion helpers — throw Error on failure (framework-agnostic).
import { deriveRunPhase } from '@sensigo/realm';
import type { RunRecord, EvidenceSnapshot, RunPhase } from '@sensigo/realm';

/**
 * Throws if run.run_phase !== expectedPhase.
 * Use to verify the workflow reached the expected terminal phase.
 */
export function assertFinalState(run: RunRecord, expectedPhase: RunPhase | string): void {
  // Ride-along (boy-scout, not the reported problem): this published assertion used to read the
  // PERSISTED `run_phase`, which the disposal rule forbids — a persisted phase can be stale, and
  // a test asserting on it can pass while the run's real phase is something else. Derive instead.
  const phase = deriveRunPhase(run);
  if (phase !== expectedPhase) {
    throw new Error(
      `assertFinalState: expected phase '${expectedPhase}' but run is in phase '${phase}'`,
    );
  }
}

/**
 * Throws if no non-gate_response snapshot with step_id === stepId and status === 'success'
 * exists in evidence.
 */
export function assertStepSucceeded(evidence: EvidenceSnapshot[], stepId: string): void {
  const found = evidence.some(
    (e) => e.step_id === stepId && e.kind !== 'gate_response' && e.status === 'success',
  );
  if (!found) {
    throw new Error(`assertStepSucceeded: no 'success' snapshot found for step '${stepId}'`);
  }
}

/**
 * Throws if no non-gate_response snapshot with step_id === stepId and status === 'error'
 * exists in evidence.
 */
export function assertStepFailed(evidence: EvidenceSnapshot[], stepId: string): void {
  const found = evidence.some(
    (e) => e.step_id === stepId && e.kind !== 'gate_response' && e.status === 'error',
  );
  if (!found) {
    throw new Error(`assertStepFailed: no 'error' snapshot found for step '${stepId}'`);
  }
}

/**
 * Throws if the last non-gate_response snapshot for stepId does not contain all keys
 * in expected (shallow check — only top-level keys are compared).
 */
export function assertStepOutput(
  evidence: EvidenceSnapshot[],
  stepId: string,
  expected: Record<string, unknown>,
): void {
  const snaps = evidence.filter((e) => e.step_id === stepId && e.kind !== 'gate_response');
  const snap = snaps[snaps.length - 1];
  if (snap === undefined) {
    throw new Error(`assertStepOutput: no snapshot found for step '${stepId}'`);
  }
  for (const [key, value] of Object.entries(expected)) {
    if (snap.output_summary[key] !== value) {
      throw new Error(
        `assertStepOutput: step '${stepId}' output_summary.${key} expected ${JSON.stringify(value)} ` +
          `but got ${JSON.stringify(snap.output_summary[key])}`,
      );
    }
  }
}

/**
 * Throws if the last non-gate_response snapshot for stepId has evidence_hash !== expectedHash.
 */
export function assertEvidenceHash(
  evidence: EvidenceSnapshot[],
  stepId: string,
  expectedHash: string,
): void {
  const snaps = evidence.filter((e) => e.step_id === stepId && e.kind !== 'gate_response');
  const snap = snaps[snaps.length - 1];
  if (snap === undefined) {
    throw new Error(`assertEvidenceHash: no snapshot found for step '${stepId}'`);
  }
  if (snap.evidence_hash !== expectedHash) {
    throw new Error(
      `assertEvidenceHash: step '${stepId}' expected hash '${expectedHash}' but got '${snap.evidence_hash}'`,
    );
  }
}
