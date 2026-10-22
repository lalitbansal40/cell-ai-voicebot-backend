import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isMonoOggOpus } from '../../src/core/meta';
import { EbmlReader, IDS, VoiceFormatError } from '../../src/modules/inbox/voice/ebml';
import { oggCrc, oggPage, segmentsFor } from '../../src/modules/inbox/voice/ogg';
import { opusPacketSamples, opusPacketStereo } from '../../src/modules/inbox/voice/opus-toc';
import { inspectOggOpus, remuxWebmOpusToOgg } from '../../src/modules/inbox/voice/webm-to-ogg';
import {
  buildWebm,
  el,
  longPacket,
  opusHeadBytes,
  readOggPages,
  silentPacket,
  sizeVint,
} from '../helpers/webm';

const reason = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(VoiceFormatError);
    return (err as VoiceFormatError).reason;
  }
  throw new Error('expected a VoiceFormatError');
};

/** Every structural property of a remuxed file. */
const checkOgg = (ogg: Buffer, expectedPackets: number, samplesPerPacket = 960) => {
  const pages = readOggPages(ogg);
  expect(pages[0]?.flags).toBe(0x02);
  expect(pages[0]?.packets[0]?.toString('latin1', 0, 8)).toBe('OpusHead');
  expect(pages[1]?.packets[0]?.toString('latin1', 0, 8)).toBe('OpusTags');
  expect(pages[1]?.packets[0]?.toString('utf8', 12, 19)).toBe('cell-ai');
  expect(pages.at(-1)?.flags).toBe(0x04);
  pages.forEach((p, i) => {
    expect(p.sequence).toBe(i);
    const zeroed = Buffer.from(p.raw);
    zeroed.writeUInt32LE(0, 22);
    expect(oggCrc(zeroed)).toBe(p.crc);
  });
  const audio = pages.slice(2);
  const granules = audio.map((p) => Number(p.granule));
  expect([...granules].sort((a, b) => a - b)).toEqual(granules);
  expect(granules.at(-1)).toBe(expectedPackets * samplesPerPacket);
  expect(audio.flatMap((p) => p.packets)).toHaveLength(expectedPackets);
  expect(isMonoOggOpus(ogg)).toBe(true);
  return pages;
};

describe('remuxWebmOpusToOgg — browser recordings', () => {
  it('Chrome-like: unknown-size segment + clusters, SimpleBlocks, OpusHead from CodecPrivate', () => {
    const r = remuxWebmOpusToOgg(buildWebm());
    const pages = checkOgg(r.ogg, 100);
    expect(r.packets).toBe(100);
    expect(r.durationSec).toBe(Math.round(((100 * 960 - 312) / 48000) * 10) / 10);
    expect(pages[0]?.packets[0]).toEqual(opusHeadBytes(1));
    // packets copied byte for byte
    expect(pages[2]?.packets[0]).toEqual(silentPacket());
    expect(inspectOggOpus(r.ogg).durationSec).toBe(r.durationSec);
  });

  it.each([
    ['known sizes', { unknownSizes: false }],
    ['BlockGroups', { blockGroup: true }],
    ['Xiph lacing', { lacing: 'xiph' as const }],
    ['EBML lacing', { lacing: 'ebml' as const }],
    ['fixed lacing', { lacing: 'fixed' as const }],
    ['laced BlockGroups', { blockGroup: true, lacing: 'xiph' as const, framesPerBlock: 5 }],
    ['one big cluster', { perCluster: 1000 }],
    ['Tracks after the first cluster', { tracksLast: true, unknownSizes: false }],
  ])('%s', (_name, opts) => {
    const r = remuxWebmOpusToOgg(buildWebm(opts));
    checkOgg(r.ogg, 100);
  });

  it('variable packet sizes (EBML / Xiph lacing with differences, packets > 255 bytes)', () => {
    const packets = Array.from({ length: 60 }, (_, i) => silentPacket(3 + ((i * 37) % 300)));
    for (const lacing of ['ebml', 'xiph'] as const) {
      const r = remuxWebmOpusToOgg(buildWebm({ packets, lacing, framesPerBlock: 3 }));
      const pages = checkOgg(r.ogg, 60);
      expect(pages.slice(2).flatMap((p) => p.packets)).toEqual(packets);
    }
  });

  it('no CodecPrivate: head built from CodecDelay (ns → samples) or the default pre-skip', () => {
    const withDelay = remuxWebmOpusToOgg(
      buildWebm({ codecPrivate: null, codecDelayNs: 6_500_000 }),
    );
    expect(readOggPages(withDelay.ogg)[0]?.packets[0]?.readUInt16LE(10)).toBe(312);
    const built = remuxWebmOpusToOgg(buildWebm({ codecPrivate: null, channels: null }));
    const head = readOggPages(built.ogg)[0]?.packets[0];
    expect(head).toEqual(opusHeadBytes(1, 312));
    // CodecPrivate that isn't an OpusHead is ignored
    expect(remuxWebmOpusToOgg(buildWebm({ codecPrivate: Buffer.from('junk') })).packets).toBe(100);
  });

  it('matroska doc type is accepted; trailing padding byte ignored', () => {
    expect(remuxWebmOpusToOgg(buildWebm({ docType: 'matroska' })).packets).toBe(100);
    expect(
      remuxWebmOpusToOgg(Buffer.concat([buildWebm({ unknownSizes: false }), Buffer.from([0])]))
        .packets,
    ).toBe(100);
  });
});

describe('remuxWebmOpusToOgg — refusals (bounded, no big allocations)', () => {
  it('stereo, other codecs, two tracks, video, not WebM', () => {
    expect(reason(() => remuxWebmOpusToOgg(buildWebm({ codecPrivate: opusHeadBytes(2) })))).toBe(
      'stereo_voice',
    );
    expect(reason(() => remuxWebmOpusToOgg(buildWebm({ codecPrivate: null, channels: 2 })))).toBe(
      'stereo_voice',
    );
    expect(reason(() => remuxWebmOpusToOgg(buildWebm({ channels: 2 })))).toBe('stereo_voice');
    expect(reason(() => remuxWebmOpusToOgg(buildWebm({ codec: 'A_VORBIS' })))).toBe('not_allowed');
    expect(reason(() => remuxWebmOpusToOgg(buildWebm({ tracks: 2 })))).toBe('not_allowed');
    expect(reason(() => remuxWebmOpusToOgg(buildWebm({ trackType: 1 })))).toBe('not_allowed');
    expect(reason(() => remuxWebmOpusToOgg(buildWebm({ docType: 'mkv3d' })))).toBe('not_allowed');
    expect(
      reason(() =>
        remuxWebmOpusToOgg(readFileSync(join(__dirname, '../fixtures/meta/media/sample.ogg'))),
      ),
    ).toBe('corrupt');
    expect(reason(() => remuxWebmOpusToOgg(el(0x1a45dfa3, [])))).toBe('not_allowed');
    expect(reason(() => remuxWebmOpusToOgg(Buffer.from('not a recording at all')))).toMatch(
      /corrupt|not_allowed/,
    );
  });

  it('truncated anywhere, corrupt sizes, huge declared sizes, odd lacing', () => {
    const good = buildWebm({ unknownSizes: false });
    for (const cut of [10, 40, 100, Math.floor(good.length / 2), good.length - 5]) {
      expect(
        reason(() => remuxWebmOpusToOgg(good.subarray(0, cut))),
        String(cut),
      ).toMatch(/corrupt|not_allowed|too_short/);
    }
    // a block inside a cluster claiming 2 GB → refused before reading
    const huge = Buffer.concat([
      el(0x1a45dfa3, [el(0x4282, Buffer.from('webm'))]),
      el(0x18538067, [
        el(0x1654ae6b, [
          el(0xae, [
            el(0xd7, Buffer.from([1])),
            el(0x83, Buffer.from([2])),
            el(0x86, Buffer.from('A_OPUS')),
          ]),
        ]),
        el(0x1f43b675, [Buffer.from([0xa3]), sizeVint(2 ** 31), Buffer.alloc(8)], { size: 20 }),
      ]),
    ]);
    const started = Date.now();
    expect(reason(() => remuxWebmOpusToOgg(huge))).toBe('corrupt');
    expect(Date.now() - started).toBeLessThan(500);
    // a vint with no length marker / an 8-byte id
    expect(reason(() => remuxWebmOpusToOgg(Buffer.from([0x00, 0x00, 0x00, 0x00])))).toBe('corrupt');
    expect(
      reason(() => remuxWebmOpusToOgg(Buffer.from([0x01, 1, 2, 3, 4, 5, 6, 7, 0x81, 0]))),
    ).toBe('corrupt');
    // unknown size on a non-container
    const unknownInfo = Buffer.concat([
      el(0x1a45dfa3, [el(0x4282, Buffer.from('webm'))]),
      el(0x18538067, [el(0x1549a966, [], { unknownSize: true })]),
    ]);
    expect(reason(() => remuxWebmOpusToOgg(unknownInfo))).toBe('corrupt');
    // a block of another track number
    const other = buildWebm({ unknownSizes: false });
    const at = other.indexOf(
      Buffer.from([0xa3]),
      other.indexOf(Buffer.from([0x1f, 0x43, 0xb6, 0x75])),
    );
    const patched = Buffer.from(other);
    patched[at + 2] = 0x82;
    expect(reason(() => remuxWebmOpusToOgg(patched))).toBe('corrupt');
    // fixed lacing that doesn't divide
    const fixed = buildWebm({
      lacing: 'fixed',
      packets: [silentPacket(3), silentPacket(4)],
      framesPerBlock: 2,
    });
    expect(reason(() => remuxWebmOpusToOgg(fixed))).toBe('corrupt');
  });

  it('nested too deep / too many elements are refused', () => {
    let deep = el(0xec, []);
    for (let i = 0; i < 12; i += 1) deep = el(0x1f43b675, [deep], { size: deep.length });
    const file = Buffer.concat([
      el(0x1a45dfa3, [el(0x4282, Buffer.from('webm'))]),
      el(0x18538067, [deep]),
    ]);
    // clusters inside clusters are read as blocks containers → corrupt / no track
    expect(reason(() => remuxWebmOpusToOgg(file))).toBe('corrupt');
  });

  it('duration limits: > 10 minutes, < 1 second, empty', () => {
    const long = Array.from({ length: 5_100 }, () => longPacket()); // 120 ms each → 612 s
    expect(reason(() => remuxWebmOpusToOgg(buildWebm({ packets: long, perCluster: 500 })))).toBe(
      'too_long',
    );
    const short = Array.from({ length: 20 }, () => silentPacket()); // 0.4 s
    expect(reason(() => remuxWebmOpusToOgg(buildWebm({ packets: short })))).toBe('too_short');
    expect(reason(() => remuxWebmOpusToOgg(buildWebm({ packets: [] })))).toBe('too_short');
    expect(reason(() => remuxWebmOpusToOgg(Buffer.alloc(16 * 1024 * 1024 + 1)))).toBe('too_long');
    // exactly at the edge (600 s of 120 ms packets + pre-skip) is fine
    const edge = Array.from({ length: 5_000 }, () => longPacket());
    const r = remuxWebmOpusToOgg(buildWebm({ packets: edge, perCluster: 500 }));
    expect(r.durationSec).toBeLessThanOrEqual(600);
    checkOgg(r.ogg, 5_000, 5760);
  });
});

describe('inspectOggOpus — uploaded OGG voice notes', () => {
  it('reads duration from the last granule; refuses stereo / non-Opus / non-OGG / bad lengths', () => {
    const sample = readFileSync(join(__dirname, '../fixtures/meta/media/sample.ogg'));
    expect(inspectOggOpus(sample).durationSec).toBe(1); // exactly 1 s after the pre-skip
    const ogg = remuxWebmOpusToOgg(buildWebm()).ogg;
    expect(inspectOggOpus(ogg).durationSec).toBeGreaterThan(1.9);
    const stereo = Buffer.from(ogg);
    stereo[28 + 9] = 2;
    expect(reason(() => inspectOggOpus(stereo))).toBe('stereo_voice');
    const vorbis = Buffer.from(ogg);
    vorbis.write('VorbisXX', 28, 'latin1');
    expect(reason(() => inspectOggOpus(vorbis))).toBe('not_allowed');
    expect(reason(() => inspectOggOpus(Buffer.from('RIFF....')))).toBe('not_allowed');
    const long = remuxWebmOpusToOgg(
      buildWebm({ packets: Array.from({ length: 4_000 }, () => longPacket()), perCluster: 500 }),
    ).ogg;
    const bumped = Buffer.from(long);
    bumped.writeBigInt64LE(
      48_000n * 700n,
      bumped.lastIndexOf('OggS', bumped.length - 4, 'latin1') + 6,
    );
    expect(reason(() => inspectOggOpus(bumped))).toBe('too_long');
    const cut = Buffer.concat([ogg.subarray(0, 60), Buffer.from('OggS')]);
    expect(reason(() => inspectOggOpus(cut))).toBe('corrupt');
  });
});

describe('opus TOC + ogg pages', () => {
  it('samples per packet for SILK / Hybrid / CELT configs and frame-count codes', () => {
    const toc = (config: number, code = 0, stereo = false) =>
      (config << 3) | (stereo ? 4 : 0) | code;
    expect([0, 1, 2, 3].map((c) => opusPacketSamples(Buffer.from([toc(c)])))).toEqual([
      480, 960, 1920, 2880,
    ]);
    expect([12, 13].map((c) => opusPacketSamples(Buffer.from([toc(c)])))).toEqual([480, 960]);
    expect([16, 17, 18, 19].map((c) => opusPacketSamples(Buffer.from([toc(c)])))).toEqual([
      120, 240, 480, 960,
    ]);
    expect(opusPacketSamples(Buffer.from([toc(19, 1)]))).toBe(1920);
    expect(opusPacketSamples(Buffer.from([toc(19, 2)]))).toBe(1920);
    expect(opusPacketSamples(Buffer.from([toc(19, 3), 3]))).toBe(2880);
    expect(opusPacketStereo(Buffer.from([toc(19, 0, true)]))).toBe(true);
    expect(opusPacketStereo(Buffer.from([toc(19)]))).toBe(false);
    for (const bad of [
      Buffer.alloc(0),
      Buffer.from([toc(19, 3)]),
      Buffer.from([toc(19, 3), 0]),
      Buffer.from([toc(3, 3), 3]),
    ]) {
      expect(() => opusPacketSamples(bad)).toThrow(VoiceFormatError);
    }
  });

  it('page lacing, CRC and the segment limit', () => {
    expect(segmentsFor(Buffer.alloc(254))).toBe(1);
    expect(segmentsFor(Buffer.alloc(255))).toBe(2);
    expect(segmentsFor(Buffer.alloc(510))).toBe(3);
    const page = oggPage([Buffer.alloc(255, 1), Buffer.alloc(3, 2)], {
      granule: 10n,
      serial: 1,
      sequence: 0,
      flags: 0,
    });
    expect(readOggPages(page)[0]?.packets.map((p) => p.length)).toEqual([255, 3]);
    expect(oggCrc(Buffer.from('OggS'))).toBe(oggCrc(Buffer.from('OggS')));
    expect(oggCrc(Buffer.alloc(0))).toBe(0);
    expect(() =>
      oggPage(
        Array.from({ length: 256 }, () => Buffer.alloc(1)),
        { granule: 0n, serial: 1, sequence: 0, flags: 0 },
      ),
    ).toThrow('too many segments');
  });

  it('EBML reader helpers', () => {
    const r = new EbmlReader(
      Buffer.concat([
        el(IDS.TrackNumber, Buffer.from([1, 2])),
        el(IDS.CodecID, Buffer.from('A_OPUS\0')),
      ]),
    );
    const a = r.header(0, r.buf.length);
    expect(r.uint(a)).toBe(258);
    const b = r.header(a.end, r.buf.length);
    expect(r.ascii(b)).toBe('A_OPUS');
    expect(() => r.uint({ id: 1, start: 0, end: 0, unknownSize: false })).toThrow(VoiceFormatError);
    expect(() => r.uint({ id: 1, start: 0, end: 9, unknownSize: false })).toThrow(VoiceFormatError);
  });
});
