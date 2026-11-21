import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { forMeta } from '../../src/core/telephony/whatsapp/meta-sdp';

describe('Meta SDP normalization', () => {
  it('keeps OPUS and telephone-event, applies offer/answer setup and canonical CRLF', async () => {
    const offer = await readFile('tests/fixtures/meta/calls-sdp-offer.txt', 'utf8');
    const normalizedOffer = forMeta(offer, 'offer');
    const normalizedAnswer = forMeta(
      offer.replaceAll('a=setup:actpass', 'a=setup:active'),
      'answer',
    );
    expect(normalizedOffer).toContain('m=audio 3480 UDP/TLS/RTP/SAVPF 111 126');
    expect(normalizedOffer).toContain('a=rtpmap:111 opus/48000/2');
    expect(normalizedOffer).toContain('a=rtpmap:126 telephone-event/8000');
    expect(normalizedOffer).toContain('a=setup:actpass');
    expect(normalizedAnswer).toContain('a=setup:active');
    expect(normalizedOffer).toContain('a=rtcp-mux');
    expect(normalizedOffer).toContain('a=fingerprint:sha-256');
    expect(normalizedOffer.endsWith('\r\n')).toBe(true);
    expect(forMeta(normalizedOffer, 'offer')).toBe(normalizedOffer);
  });

  it('rewrites private host candidates to configured public address and filters extmaps/codecs', async () => {
    const offer = await readFile('tests/fixtures/meta/calls-sdp-offer.txt', 'utf8');
    const input = offer
      .replace('203.0.113.10 3480 typ host', '192.168.1.10 3480 typ host')
      .replace(
        'a=ice-ufrag:testufrag',
        'a=ice-ufrag:testufrag\na=candidate:2 1 udp 2122260222 fd00::2 3481 typ host\na=candidate:3 1 udp 2122260221 abcdef.local 3482 typ host',
      )
      .replace(
        'a=rtpmap:126 telephone-event/8000',
        'a=rtpmap:126 telephone-event/8000\na=rtpmap:0 PCMU/8000',
      )
      .replace('111 126', '111 126 0')
      .replace(
        'a=rtcp-mux',
        'a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid\na=extmap:2 urn:ietf:params:rtp-hdrext:ssrc-audio-level\na=rtcp-mux',
      );
    const normalized = forMeta(input, 'offer', { publicIp: '198.51.100.20' });
    expect(normalized).toContain('198.51.100.20 3480 typ host');
    expect(normalized).not.toContain('192.168.1.10');
    expect(normalized).not.toContain('fd00::2');
    expect(normalized).not.toContain('abcdef.local');
    expect(normalized).not.toContain('PCMU');
    expect(normalized).not.toContain('sdes:mid');
    expect(normalized).toContain('ssrc-audio-level');
  });
});
