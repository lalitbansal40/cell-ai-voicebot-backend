import { OGG_FLAGS, oggPage, opusHead, opusTags } from './voice/ogg';

/**
 * DEV / TEST ONLY — tiny media files for the simulator (no real content): what a
 * customer "sends" through the fake Meta. Each passes our sniffing for its type.
 */
const JPEG_1PX = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);
const WEBP_1PX = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');

const mp4 = (): Buffer => {
  const ftyp = Buffer.alloc(24);
  ftyp.writeUInt32BE(24, 0);
  ftyp.write('ftypisom', 4, 'latin1');
  ftyp.writeUInt32BE(512, 12);
  ftyp.write('isomiso2', 16, 'latin1');
  return Buffer.concat([ftyp, Buffer.from([0, 0, 0, 16]), Buffer.from('freedev-mp4!', 'latin1')]);
};

/** A 2 s mono OGG / Opus voice note of silent 20 ms frames. */
export const devVoiceNote = (seconds = 2): Buffer => {
  const packets = Array.from({ length: Math.round(seconds * 50) }, () =>
    Buffer.from([0xf8, 0xff, 0xfe]),
  );
  const serial = 0x64657600;
  const pages = [
    oggPage([opusHead(1, 312, 48_000)], { granule: 0n, serial, sequence: 0, flags: OGG_FLAGS.bos }),
    oggPage([opusTags('cell-ai-dev')], { granule: 0n, serial, sequence: 1, flags: 0 }),
  ];
  for (let i = 0, seq = 2; i < packets.length; i += 50, seq += 1) {
    const batch = packets.slice(i, i + 50);
    const done = i + batch.length;
    pages.push(
      oggPage(batch, {
        granule: BigInt(done * 960),
        serial,
        sequence: seq,
        flags: done >= packets.length ? OGG_FLAGS.eos : 0,
      }),
    );
  }
  return Buffer.concat(pages);
};

export const DEV_MEDIA = {
  image: () => ({ bytes: JPEG_1PX, mime: 'image/jpeg', fileName: null }),
  video: () => ({ bytes: mp4(), mime: 'video/mp4', fileName: null }),
  audio: () => ({ bytes: devVoiceNote(3), mime: 'audio/ogg', fileName: null }),
  voice: () => ({ bytes: devVoiceNote(2), mime: 'audio/ogg; codecs=opus', fileName: null }),
  document: () => ({
    bytes: Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'),
    mime: 'application/pdf',
    fileName: 'test-statement.pdf',
  }),
  sticker: () => ({ bytes: WEBP_1PX, mime: 'image/webp', fileName: null }),
} as const;
