"""Writes the lab's raw G.711 mu-law clips (8 kHz): a long machine greeting and a short hello."""

import math
import os
import sys


def ulaw(sample: int) -> int:
    bias, clip = 0x84, 32635
    sign = 0x80 if sample < 0 else 0
    sample = min(abs(sample), clip) + bias
    exponent, mask = 7, 0x4000
    while exponent > 0 and not sample & mask:
        exponent -= 1
        mask >>= 1
    mantissa = (sample >> (exponent + 3)) & 0x0F
    return ~(sign | (exponent << 4) | mantissa) & 0xFF


def tone(ms: int, freq: float = 440.0, amp: int = 8000) -> bytes:
    n = 8 * ms
    return bytes(ulaw(int(amp * math.sin(2 * math.pi * freq * i / 8000))) for i in range(n))


def silence(ms: int) -> bytes:
    return bytes([0xFF]) * (8 * ms)


out = sys.argv[1]
os.makedirs(out, exist_ok=True)
clips = {
    # A recorded greeting: speech-like bursts for about 4 s.
    "machine.ulaw": b"".join(tone(700, 300 + 50 * k) + silence(80) for k in range(5)) + silence(3000),
    # A person: a short "hello", then waiting.
    "human.ulaw": tone(400, 350) + silence(3000),
}
for name, data in clips.items():
    with open(os.path.join(out, name), "wb") as f:
        f.write(data)
