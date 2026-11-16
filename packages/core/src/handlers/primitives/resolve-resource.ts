/**
 * Reads a named field from a prior step's output stored in context.resources.
 */

/**
 * Reads a named field from a prior step's output stored in context.resources.
 *
 * @param resources  The context.resources object from StepContext. May be undefined.
 * @param stepId     The step whose output to read (e.g. "fetch_document").
 * @param fieldName  The field within that step's output (e.g. "text").
 * @returns          The field value, or undefined if the step or field is absent.
 * @public
 */
export function resolveResource(
  resources: Record<string, unknown> | undefined,
  stepId: string,
  fieldName: string,
): unknown {
  if (resources === undefined) return undefined;
  const stepOutput = resources[stepId];
  if (stepOutput === null || typeof stepOutput !== 'object' || Array.isArray(stepOutput)) {
    return undefined;
  }
  return (stepOutput as Record<string, unknown>)[fieldName];
}
