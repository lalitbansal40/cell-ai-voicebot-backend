import { describe, expect, it, vi } from 'vitest';

import { Cell24x7VoiceClient, parseResultRow } from './cell24x7.client';
import { pulsesFor, toReceiver10, VoiceApiError } from './types';

const TOKEN = 'test-token-not-real-0000';

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const clientWith = (fetchFn: typeof fetch) =>
  new Cell24x7VoiceClient({
    baseUrl: 'https://voice.example/api/v1/voice/partner',
    token: TOKEN,
    fetch: fetchFn,
  });

const submitInput = {
  broadcastName: 'cav-abc-1',
  callerId: '9999999999',
  numbers: ['9324479120', '9326313808'],
  audio: { kind: 'audio_id' as const, id: 123 },
  retries: 1,
  retryIntervalMin: 30 as const,
};

describe('Cell24x7VoiceClient', () => {
  it('submits multipart with a CSV of 10-digit numbers and the bearer token', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      reply(201, {
        success: true,
        data: { request_id: 'VCAMP_1', contacts: 2, credits_deducted: 4, audio_file_id: 123 },
      }),
    );
    const result = await clientWith(fetchFn).submit(submitInput);
    expect(result).toEqual({
      requestId: 'VCAMP_1',
      contacts: 2,
      creditsDeducted: 4,
      audioFileId: 123,
    });
    const [url, init] = fetchFn.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('https://voice.example/api/v1/voice/partner/submit');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    const form = init.body as FormData;
    expect(form.get('broadcast_name')).toBe('cav-abc-1');
    expect(form.get('caller_id')).toBe('9999999999');
    expect(form.get('audio_file_id')).toBe('123');
    expect(form.get('retries')).toBe('1');
    expect(form.get('retry_interval')).toBe('30');
    expect(form.has('textbox')).toBe(false);
    expect(await (form.get('csv_file') as Blob).text()).toBe('number\n9324479120\n9326313808\n');
  });

  it('sends a file or an IVR instead of an audio id', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(reply(201, { success: true, data: { request_id: 'VCAMP_2' } })),
      );
    const client = clientWith(fetchFn);
    await client.submit({
      ...submitInput,
      retries: 0,
      audio: { kind: 'file', data: Buffer.from('RIFF'), filename: 'a.wav', mime: 'audio/wav' },
    });
    await client.submit({ ...submitInput, audio: { kind: 'ivr', id: 7 } });
    const first = (fetchFn.mock.calls[0] as [URL, RequestInit])[1].body as FormData;
    const second = (fetchFn.mock.calls[1] as [URL, RequestInit])[1].body as FormData;
    expect((first.get('audio_file') as File).name).toBe('a.wav');
    expect(first.has('retry_interval')).toBe(false);
    expect(second.get('ivr_id')).toBe('7');
  });

  it.each([
    [400, 'VOICE_API_REJECTED', false],
    [401, 'VOICE_API_AUTH', false],
    [402, 'VOICE_API_NO_CREDITS', false],
    [404, 'VOICE_API_NOT_FOUND', false],
    [503, 'VOICE_API_UNAVAILABLE', true],
  ])('maps HTTP %i to %s', async (status, code, uncertain) => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        reply(status, { success: false, message: 'required 4 available 0 for 9324479120' }),
      );
    const err = (await clientWith(fetchFn)
      .submit(submitInput)
      .catch((e: unknown) => e)) as VoiceApiError;
    expect(err).toBeInstanceOf(VoiceApiError);
    expect(err.code).toBe(code);
    expect(err.uncertain).toBe(uncertain);
    expect(err.message).not.toContain('9324479120');
    expect(err.message).not.toContain(TOKEN);
  });

  it('treats a network failure or an unreadable 2xx as uncertain', async () => {
    const down = clientWith(vi.fn<typeof fetch>().mockRejectedValue(new Error('ECONNRESET')));
    await expect(down.submit(submitInput)).rejects.toMatchObject({ uncertain: true });
    const odd = clientWith(vi.fn<typeof fetch>().mockResolvedValue(reply(201, { success: true })));
    await expect(odd.submit(submitInput)).rejects.toMatchObject({
      code: 'VOICE_API_UNAVAILABLE',
      uncertain: true,
    });
  });

  it('reads details rows leniently and pages by 100', async () => {
    const rows = [
      {
        receiver: '9324479120',
        status: 'ANSWERED',
        duration: 21,
        retry_count: 1,
        dtmf_pressed: '1',
      },
      { mobile: '919326313808', status: 'NO ANSWER' },
      { status: 'BUSY' },
    ];
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(reply(200, { success: true, data: rows }));
    const page = await clientWith(fetchFn).details('VCAMP_1', 2);
    const [url] = fetchFn.mock.calls[0] as [URL];
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('limit')).toBe('100');
    expect(page.hasMore).toBe(false);
    expect(page.rows).toEqual([
      {
        receiver: '9324479120',
        status: 'ANSWERED',
        durationSec: 21,
        retryCount: 1,
        dtmf: '1',
        ivrDisposition: null,
      },
      {
        receiver: '9326313808',
        status: 'NO ANSWER',
        durationSec: 0,
        retryCount: 0,
        dtmf: null,
        ivrDisposition: null,
      },
    ]);
    expect(parseResultRow({ receiver: '9324479120', status: 'Submitted' })?.status).toBe(
      'Submitted',
    );
  });

  it('lists runnable IVRs and helpers convert numbers and pulses', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        reply(200, { success: true, data: [{ id: 5, name: 'Menu', runnable: true }, { id: 'x' }] }),
      );
    expect(await clientWith(fetchFn).ivrs()).toEqual([{ id: 5, name: 'Menu', runnable: true }]);
    expect(toReceiver10('+919324479120')).toBe('9324479120');
    expect(toReceiver10('+911412345678')).toBeNull();
    expect(toReceiver10('+14155550100')).toBeNull();
    expect([pulsesFor(1), pulsesFor(15), pulsesFor(16), pulsesFor(24), pulsesFor(120)]).toEqual([
      1, 1, 2, 2, 8,
    ]);
  });
});
