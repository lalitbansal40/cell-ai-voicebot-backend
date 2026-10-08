import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { linearToMulaw, mulawWav, parseRtp } from './rtp.ts';

const packet = (payload: number[], opts: { csrc?: number; pt?: number } = {}) => {
  const csrc = opts.csrc ?? 0;
  const header = Buffer.alloc(12 + csrc * 4);
  header[0] = 0x80 | csrc;
  header[1] = opts.pt ?? 0;
  header.writeUInt16BE(42, 2);
  header.writeUInt32BE(1600, 4);
  header.writeUInt32BE(0xdeadbeef, 8);
  return Buffer.concat([header, Buffer.from(payload)]);
};

describe('parseRtp', () => {
  it('parses a PCMU packet', () => {
    const p = parseRtp(packet([1, 2, 3]));
    assert.equal(p?.payloadType, 0);
    assert.equal(p?.sequence, 42);
    assert.equal(p?.ssrc, 0xdeadbeef);
    assert.deepEqual([...(p?.payload ?? [])], [1, 2, 3]);
  });

  it('skips CSRC entries', () => {
    assert.deepEqual([...(parseRtp(packet([9], { csrc: 2 }))?.payload ?? [])], [9]);
  });

  it('rejects short or non-v2 packets', () => {
    assert.equal(parseRtp(Buffer.alloc(5)), undefined);
    const bad = packet([1]);
    bad[0] = 0x40;
    assert.equal(parseRtp(bad), undefined);
  });
});

describe('μ-law helpers', () => {
  it('encodes silence as 0xff', () => assert.equal(linearToMulaw(0), 0xff));
  it('writes a μ-law WAV header', () => {
    const wav = mulawWav(new Uint8Array(80));
    assert.equal(wav.length, 124);
    assert.equal(wav.readUInt16LE(20), 7);
    assert.equal(wav.readUInt32LE(24), 8000);
  });
});
