/**
 * Goertzel tone power for "did the other side hear the tone" checks (PoC,
 * fake WhatsApp user, tests). Returns the relative power of `hz` in the block.
 */
export const tonePower = (pcm: Int16Array, rate: number, hz: number): number => {
  const n = pcm.length;
  if (n === 0) return 0;
  const k = Math.round((n * hz) / rate);
  const w = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i += 1) {
    const s = (pcm[i] ?? 0) / 32768 + coeff * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return power / (n * n);
};

/** True when `hz` dominates (≥ 10× the power at the other frequency). */
export const hasTone = (pcm: Int16Array, rate: number, hz: number, other: number): boolean => {
  const p = tonePower(pcm, rate, hz);
  return p > 1e-4 && p >= 10 * tonePower(pcm, rate, other);
};
