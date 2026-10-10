import { describe, expect, it } from 'vitest';

import { canonicalGraph, diffSummary, graphChecksum, graphSizeBytes } from './canonical';

const graph = {
  schemaVersion: 1,
  nodes: [{ id: 'a', type: 'start', position: { x: 0, y: 0 }, config: { triggers: ['test'] } }],
  edges: [],
  viewport: { x: 1, y: 2, zoom: 1 },
};

describe('canonical graph', () => {
  it('sorts keys, drops viewport and undefined values, keeps array order', () => {
    expect(
      JSON.stringify(canonicalGraph({ b: 1, a: { d: [3, 1], c: undefined }, viewport: {} })),
    ).toBe('{"a":{"d":[3,1]},"b":1}');
  });

  it('checksum ignores key order and viewport but sees positions', () => {
    const shuffled = {
      edges: [],
      viewport: { x: 9, y: 9, zoom: 2 },
      nodes: [{ config: { triggers: ['test'] }, position: { y: 0, x: 0 }, type: 'start', id: 'a' }],
      schemaVersion: 1,
    };
    expect(graphChecksum(shuffled)).toBe(graphChecksum(graph));
    expect(graphChecksum(graph)).toMatch(/^[a-f0-9]{64}$/);
    const moved = { ...graph, nodes: [{ ...graph.nodes[0], position: { x: 1, y: 0 } }] };
    expect(graphChecksum(moved)).not.toBe(graphChecksum(graph));
    expect(graphSizeBytes({ a: 'é' })).toBe(Buffer.byteLength('{"a":"é"}'));
  });

  it('summarises a change for the publish audit', () => {
    const prev = {
      nodes: [
        { id: 'a', x: 1 },
        { id: 'b', x: 1 },
        { id: 'c', x: 1 },
      ],
      edges: [
        { id: 'e1', t: 'b' },
        { id: 'e2', t: 'c' },
      ],
    };
    const next = {
      nodes: [
        { id: 'a', x: 1 },
        { id: 'b', x: 2 },
        { id: 'd', x: 1 },
      ],
      edges: [
        { id: 'e1', t: 'd' },
        { id: 'e3', t: 'a' },
      ],
    };
    expect(diffSummary(prev, next)).toEqual({
      nodesAdded: 1,
      nodesRemoved: 1,
      nodesChanged: 1,
      edgesChanged: 3,
    });
    expect(diffSummary(null, next)).toEqual({
      nodesAdded: 3,
      nodesRemoved: 0,
      nodesChanged: 0,
      edgesChanged: 2,
    });
    expect(diffSummary(next, next)).toEqual({
      nodesAdded: 0,
      nodesRemoved: 0,
      nodesChanged: 0,
      edgesChanged: 0,
    });
  });
});
