/**
 * Equality on a field whose index is partial on `{ field: { $type: 'string' } }`. Mongo only uses
 * such an index when the query repeats the `$type`: a plain `{ field: value }` scans instead.
 */
export const stringEq = (value: string) => ({ $eq: value, $type: 'string' as const });
