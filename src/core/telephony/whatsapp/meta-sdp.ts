export type MetaSdpKind = 'offer' | 'answer';

const privateIp = (ip: string): boolean => {
  const lower = ip.toLowerCase().split('%')[0] ?? ip.toLowerCase();
  if (lower.includes(':')) {
    if (lower.startsWith('::ffff:')) return privateIp(lower.slice('::ffff:'.length));
    return (
      lower === '::' ||
      lower === '::1' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      /^fe[89ab]/.test(lower)
    );
  }
  if (lower.endsWith('.local')) return true;
  const parts = lower.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255))
    return false;
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 169 && parts[1] === 254) ||
    parts[0] === 0
  );
};

/** Reduce werift / Meta SDP to Meta's single audio, non-trickle call profile. */
export const forMeta = (
  sdp: string,
  kind: MetaSdpKind,
  options: { publicIp?: string | null } = {},
): string => {
  const input = sdp.split(/\r?\n/).filter(Boolean);
  const session: string[] = [];
  const sections: { audio: boolean; lines: string[] }[] = [];
  for (const line of input) {
    if (line.startsWith('m=')) {
      sections.push({ audio: line.startsWith('m=audio '), lines: [line] });
      continue;
    }
    const section = sections.at(-1);
    if (section) section.lines.push(line);
    else if (!line.startsWith('a=setup:')) session.push(line);
  }
  const audio = sections.find((section) => section.audio)?.lines ?? [];
  if (!audio.length) throw new Error('Meta SDP must contain an audio media section');

  const mline = audio[0] ?? '';
  const match = /^m=audio (\d+) (\S+) (.+)$/.exec(mline);
  if (!match) throw new Error('Meta SDP audio media line is invalid');
  const payloads = match[3]!.split(/\s+/);
  const mappings = new Map<number, { name: string; rate: string; channels: string }>();
  for (const line of audio) {
    const rtpmap = /^a=rtpmap:(\d+) ([^/]+)\/(\d+)(?:\/(\d+))?$/i.exec(line);
    if (rtpmap)
      mappings.set(Number(rtpmap[1]), {
        name: rtpmap[2]!.toLowerCase(),
        rate: rtpmap[3]!,
        channels: rtpmap[4] ?? '1',
      });
  }
  const opus = payloads.find((pt) => {
    const codec = mappings.get(Number(pt));
    return codec?.name === 'opus' && codec.rate === '48000' && codec.channels === '2';
  });
  if (!opus) throw new Error('Meta SDP must offer OPUS 48000/2');
  const telephone = payloads.find((pt) => {
    const codec = mappings.get(Number(pt));
    return codec?.name === 'telephone-event' && codec.rate === '8000';
  });
  const keep = new Set([opus, ...(telephone ? [telephone] : [])]);
  const outAudio: string[] = [];
  let publicCandidateFound = false;
  for (const line of audio.slice(1)) {
    if (line.startsWith('a=setup:')) continue;
    if (
      line.startsWith('a=extmap:') &&
      !line.includes('urn:ietf:params:rtp-hdrext:ssrc-audio-level')
    )
      continue;
    const codecLine = /^a=(?:rtpmap|fmtp|rtcp-fb):(\d+|\*)/.exec(line);
    if (codecLine && codecLine[1] !== '*' && !keep.has(codecLine[1]!)) continue;
    if (line.startsWith('a=candidate:') && options.publicIp) {
      const candidate =
        /^(a=candidate:\S+\s+\d+\s+\S+\s+\d+\s+)(\S+)(\s+\d+\s+typ\s+host\b.*)$/i.exec(line);
      if (candidate && privateIp(candidate[2]!)) {
        outAudio.push(`${candidate[1]}${options.publicIp}${candidate[3]}`);
        publicCandidateFound = true;
        continue;
      }
      if (candidate && candidate[2] === options.publicIp) publicCandidateFound = true;
    }
    outAudio.push(line);
  }
  if (options.publicIp && !publicCandidateFound) {
    const privateHost = audio.find((line) => {
      const c = /^a=candidate:\S+\s+\d+\s+\S+\s+\d+\s+(\S+)\s+\d+\s+typ\s+host\b/i.exec(line);
      return c && privateIp(c[1]!);
    });
    const c =
      privateHost &&
      /^a=candidate:(\S+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\d+)\s+typ\s+host\b(.*)$/i.exec(
        privateHost,
      );
    if (c)
      outAudio.push(
        `a=candidate:${c[1]} ${c[2]} ${c[3]} ${c[4]} ${options.publicIp} ${c[6]} typ host${c[7]}`,
      );
  }
  const rewrittenMline = `m=audio ${match[1]} ${match[2]} ${[...keep].join(' ')}`;
  const setup = `a=setup:${kind === 'offer' ? 'actpass' : 'active'}`;
  if (!outAudio.includes('a=rtcp-mux')) outAudio.push('a=rtcp-mux');
  const result = [
    ...session.filter((line) => !line.startsWith('m=')),
    rewrittenMline,
    setup,
    ...outAudio,
  ];
  return `${result.join('\r\n')}\r\n`;
};
