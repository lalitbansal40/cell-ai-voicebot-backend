import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { realtimeCostUsd, transcriptionCostUsd } from './pricing.ts';

describe('realtimeCostUsd', () => {
  it('prices audio + text tokens for gpt-realtime-2.1', () => {
    const cost = realtimeCostUsd('gpt-realtime-2.1', {
      input_token_details: { text_tokens: 1000, audio_tokens: 1000 },
      output_token_details: { text_tokens: 100, audio_tokens: 1000 },
    });
    // 1000*4 + 1000*32 + 100*24 + 1000*64 per 1M
    assert.equal(Number(cost.toFixed(6)), Number(((4000 + 32000 + 2400 + 64000) / 1e6).toFixed(6)));
  });

  it('charges cached tokens at the cached rate', () => {
    const cost = realtimeCostUsd('gpt-realtime-2.1-mini', {
      input_token_details: {
        text_tokens: 1000,
        cached_tokens: 1000,
        cached_tokens_details: { text_tokens: 1000, audio_tokens: 0 },
      },
    });
    assert.equal(Number(cost.toFixed(8)), Number(((1000 * 0.06) / 1e6).toFixed(8)));
  });

  it('returns 0 without usage and throws for unknown models', () => {
    assert.equal(realtimeCostUsd('gpt-realtime-2.1', undefined), 0);
    assert.throws(() => realtimeCostUsd('unknown-model', {}));
  });
});

describe('transcriptionCostUsd', () => {
  it('prices per minute', () => {
    assert.equal(transcriptionCostUsd('gpt-4o-mini-transcribe', 60_000), 0.003);
  });
});
