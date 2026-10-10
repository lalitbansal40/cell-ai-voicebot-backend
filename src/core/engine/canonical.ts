import { createHash } from 'node:crypto';

type Plain = string | number | boolean | null | Plain[] | { [key: string]: Plain };

const sortKeys = (value: unknown): Plain => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value as Plain;
};

/**
 * Canonical form of a graph: `viewport` dropped (builder only), object keys
 * sorted recursively, array order kept. Positions stay — a version restores the layout.
 */
export const canonicalGraph = (graph: Record<string, unknown>): Plain => {
  const { viewport: _viewport, ...rest } = graph;
  return sortKeys(rest);
};

export const canonicalJson = (graph: Record<string, unknown>): string =>
  JSON.stringify(canonicalGraph(graph));

/** sha256 (hex) of the canonical graph JSON. */
export const graphChecksum = (graph: Record<string, unknown>): string =>
  createHash('sha256').update(canonicalJson(graph)).digest('hex');

/** Size of the canonical JSON in bytes (limit `graphMaxBytes`). */
export const graphSizeBytes = (graph: Record<string, unknown>): number =>
  Buffer.byteLength(canonicalJson(graph), 'utf8');

export interface DiffSummary {
  nodesAdded: number;
  nodesRemoved: number;
  nodesChanged: number;
  edgesChanged: number;
}

interface WithId {
  id: string;
}
const byId = <T extends WithId>(items: readonly T[]) =>
  new Map(items.map((i) => [i.id, JSON.stringify(sortKeys(i))]));

/** Counts for the `flow.published` audit row (no texts). */
export const diffSummary = (
  prev: { nodes: readonly WithId[]; edges: readonly WithId[] } | null,
  next: { nodes: readonly WithId[]; edges: readonly WithId[] },
): DiffSummary => {
  const before = byId(prev?.nodes ?? []);
  const after = byId(next.nodes);
  let nodesAdded = 0;
  let nodesChanged = 0;
  for (const [id, json] of after) {
    const old = before.get(id);
    if (old === undefined) nodesAdded += 1;
    else if (old !== json) nodesChanged += 1;
  }
  const nodesRemoved = [...before.keys()].filter((id) => !after.has(id)).length;
  const edgesBefore = byId(prev?.edges ?? []);
  const edgesAfter = byId(next.edges);
  let edgesChanged = [...edgesBefore.keys()].filter((id) => !edgesAfter.has(id)).length;
  for (const [id, json] of edgesAfter) if (edgesBefore.get(id) !== json) edgesChanged += 1;
  return { nodesAdded, nodesRemoved, nodesChanged, edgesChanged };
};
