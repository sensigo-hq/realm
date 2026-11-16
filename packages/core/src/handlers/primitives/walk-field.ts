/**
 * Recursively walks any value and collects all objects that contain a
 * property named fieldName.
 *
 * @param data       The value to walk. Can be any JSON-compatible value.
 * @param fieldName  The property name to search for.
 * @returns          An array of every object (not array) that has fieldName as
 *                   a direct own property.
 * @public
 */
export function walkField(data: unknown, fieldName: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  collect(data, fieldName, results);
  return results;
}

function collect(data: unknown, fieldName: string, results: Record<string, unknown>[]): void {
  if (Array.isArray(data)) {
    for (const item of data) {
      collect(item, fieldName, results);
    }
  } else if (data !== null && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(obj, fieldName)) {
      results.push(obj);
    }
    for (const value of Object.values(obj)) {
      collect(value, fieldName, results);
    }
  }
}
