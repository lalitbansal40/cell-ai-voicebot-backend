/**
 * SDP helpers for WhatsApp calls (plan §1h, ADR 0040). The raw SDP carries ICE
 * credentials, candidates and the DTLS fingerprint, so it is never logged:
 * `describeSdp` returns only its shape, `scrubSdp` a log-safe summary string.
 */
export interface SdpCodec {
  payloadType: number;
  name: string;
  clockRate: number;
  channels: number | null;
}

export interface SdpShape {
  iceLite: boolean;
  setup: 'active' | 'passive' | 'actpass' | null;
  rtcpMux: boolean;
  bundle: boolean;
  audioSections: number;
  codecs: SdpCodec[];
  ssrcCount: number;
  candidateCount: number;
  hasFingerprint: boolean;
  hasIceCredentials: boolean;
}

const lines = (sdp: string): string[] => sdp.split(/\r?\n/).filter((l) => l.length > 0);

export const describeSdp = (sdp: string): SdpShape => {
  const all = lines(sdp);
  const codecs: SdpCodec[] = [];
  const ssrcs = new Set<string>();
  let setup: SdpShape['setup'] = null;
  for (const l of all) {
    const rtpmap = /^a=rtpmap:(\d+) ([^/]+)\/(\d+)(?:\/(\d+))?$/.exec(l);
    if (rtpmap) {
      codecs.push({
        payloadType: Number(rtpmap[1]),
        name: (rtpmap[2] ?? '').toLowerCase(),
        clockRate: Number(rtpmap[3]),
        channels: rtpmap[4] ? Number(rtpmap[4]) : null,
      });
    }
    const ssrc = /^a=ssrc:(\d+) /.exec(l);
    if (ssrc?.[1]) ssrcs.add(ssrc[1]);
    const role = /^a=setup:(active|passive|actpass)$/.exec(l);
    if (role) setup = role[1] as SdpShape['setup'];
  }
  return {
    iceLite: all.includes('a=ice-lite'),
    setup,
    rtcpMux: all.includes('a=rtcp-mux'),
    bundle: all.some((l) => l.startsWith('a=group:BUNDLE ')),
    audioSections: all.filter((l) => l.startsWith('m=audio ')).length,
    codecs,
    ssrcCount: ssrcs.size,
    candidateCount: all.filter((l) => l.startsWith('a=candidate:')).length,
    hasFingerprint: all.some((l) => l.startsWith('a=fingerprint:')),
    hasIceCredentials:
      all.some((l) => l.startsWith('a=ice-ufrag:')) && all.some((l) => l.startsWith('a=ice-pwd:')),
  };
};

/** Log-safe summary (no credentials, candidates, fingerprints or addresses). */
export const scrubSdp = (sdp: string): string => {
  const s = describeSdp(sdp);
  const codecs = s.codecs.map((c) => `${c.name}/${String(c.clockRate)}`).join(',');
  return `sdp(audio=${String(s.audioSections)} codecs=${codecs} setup=${s.setup ?? '-'} lite=${String(s.iceLite)} candidates=${String(s.candidateCount)})`;
};

/** Adds `a=ptime:20` after the Opus `fmtp` line (Meta's samples carry it; werift does not write it). */
export const withPtime = (sdp: string, ptime = 20): string => {
  if (/^a=ptime:/m.test(sdp)) return sdp;
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  return sdp.replace(/^(a=fmtp:111 [^\r\n]*)$/m, `$1${eol}a=ptime:${String(ptime)}`);
};
