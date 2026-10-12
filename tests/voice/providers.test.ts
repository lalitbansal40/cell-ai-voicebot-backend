import { describe, expect, it, vi } from 'vitest';

import { loadEnv } from '../../src/config/env';
import { decodeMulaw, encodeMulaw } from '../../src/core/voice/audio/g711';
import { toBytes } from '../../src/core/voice/audio/pcm';
import {
  ChatVoiceProvider,
  ChatVoiceSession,
  createVoiceProviders,
  defaultSocketFactory,
  FakeStt,
  FakeSttSession,
  FakeTts,
  fakeTtsMs,
  OpenAiStt,
  OpenAiTts,
  openRealtimeSession,
  openSocket,
  parseRealtimeEvent,
  RealtimeVoiceProvider,
  RealtimeVoiceSession,
  realtimeUrl,
  TtsError,
  usageOf,
  type FetchLike,
  type TurnDone,
  type VoiceSessionOptions,
} from '../../src/core/voice/providers';
import { FakeSocket, realtimeFixture } from '../helpers/fake-socket';

const OPTIONS: VoiceSessionOptions = {
  instructions: 'Be polite.',
  voice: 'coral',
  tools: [
    {
      name: 'check_payment_status',
      description: 'Check',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  ],
  bargeIn: true,
  rate: 24_000,
  language: null,
  speechLanguage: 'hinglish',
};

const deps = (socket: FakeSocket) => ({
  apiKey: 'test-key',
  baseUrl: 'https://api.example.test/v1/',
  model: 'gpt-realtime-2.1-mini',
  transcribeModel: 'gpt-4o-mini-transcribe',
  connect: (url: string, headers: Record<string, string>) => {
    socket.emit('connect-args', url, headers);
    setImmediate(() => socket.emit('open'));
    return socket;
  },
});

const collect = (session: RealtimeVoiceSession) => {
  const seen: string[] = [];
  const audio: Int16Array[] = [];
  session.on('speech_started', () => seen.push('speech_started'));
  session.on('speech_stopped', () => seen.push('speech_stopped'));
  session.on('customer_transcript', (e) => seen.push(`customer:${e.text}:${String(e.language)}`));
  session.on('bot_audio', (pcm) => audio.push(pcm));
  session.on('bot_transcript', (e) => seen.push(`bot:${e.text}`));
  session.on('bot_done', () => seen.push('done'));
  session.on('tool_call', (c) => seen.push(`tool:${c.name}:${c.callId}:${c.args}`));
  session.on('usage', (u) => seen.push(`usage:${String(u.inputTextTokens)}`));
  session.on('error', (e) => seen.push(`error:${e.code}:${String(e.fatal)}`));
  return { seen, audio };
};

describe('Realtime events', () => {
  it('parses known events, ignores others; usage defaults to zero', () => {
    expect(parseRealtimeEvent('{"type":"session.updated"}')).toEqual({ type: 'session.updated' });
    expect(parseRealtimeEvent(Buffer.from('{"type":"input_audio_buffer.speech_started"}'))).toEqual(
      { type: 'input_audio_buffer.speech_started' },
    );
    expect(parseRealtimeEvent('not json')).toBeNull();
    expect(parseRealtimeEvent({ type: 'rate_limits.updated' })).toBeNull();
    expect(parseRealtimeEvent({ type: 'response.output_audio.delta' })).toBeNull();
    expect(usageOf(undefined)).toEqual({
      inputAudioTokens: 0,
      outputAudioTokens: 0,
      inputTextTokens: 0,
      outputTextTokens: 0,
      cachedTokens: 0,
    });
    expect(realtimeUrl('https://api.openai.com/v1/', 'gpt x')).toBe(
      'wss://api.openai.com/v1/realtime?model=gpt%20x',
    );
    expect(realtimeUrl('http://localhost:9/v1', 'm', 'transcription')).toBe(
      'ws://localhost:9/v1/realtime?intent=transcription',
    );
  });
});

describe('RealtimeVoiceSession', () => {
  it('configures the session and replays a basic turn', async () => {
    const socket = new FakeSocket();
    const args: unknown[] = [];
    socket.on('connect-args', (...a: unknown[]) => args.push(...a));
    const session = await openRealtimeSession(OPTIONS, deps(socket));
    expect(args[0]).toBe('wss://api.example.test/v1/realtime?model=gpt-realtime-2.1-mini');
    expect(args[1]).toEqual({ Authorization: 'Bearer test-key' });
    const update = socket.sent[0] as { session: Record<string, unknown> };
    expect(update).toMatchObject({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: 'Be polite.',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            turn_detection: { type: 'server_vad', interrupt_response: true },
            transcription: { model: 'gpt-4o-mini-transcribe' },
          },
          output: { voice: 'coral' },
        },
        tools: [{ type: 'function', name: 'check_payment_status' }],
      },
    });
    const { seen, audio } = collect(session);
    for (const e of realtimeFixture('basic-turn')) socket.receive(e);
    expect(seen).toEqual([
      'speech_started',
      'speech_stopped',
      'customer:maine pay kar diya:hi',
      'bot:Dhanyavaad! Payment mil gaya.',
      'usage:200',
      'done',
    ]);
    expect(audio.map((a) => a.length)).toEqual([480, 480]);
    expect(audio[1]?.[0]).toBe(-1000);
    expect(session.ignored).toBe(1); // response.created
    // barge-in truncates the item that was playing
    session.truncate(345.6);
    expect(socket.sent.at(-1)).toEqual({
      type: 'conversation.item.truncate',
      item_id: 'item_b1',
      content_index: 0,
      audio_end_ms: 346,
    });
    const count = socket.sent.length;
    session.truncate(10); // nothing playing any more
    expect(socket.sent).toHaveLength(count);
    await session.close();
    expect(socket.closedWith).toBe(1000);
    session.sendAudio(new Int16Array(4));
    expect(socket.sent).toHaveLength(count); // nothing after close
    await session.close();
  });

  it('tool calls, outputs, typed text, fixed lines, μ-law audio and errors', () => {
    const socket = new FakeSocket();
    const session = new RealtimeVoiceSession(socket, { ...OPTIONS, rate: 8_000, bargeIn: false });
    const { seen, audio } = collect(session);
    for (const e of realtimeFixture('function-call')) socket.receive(e);
    expect(seen).toContain('tool:check_payment_status:call_abc:{}');
    session.submitToolResults([{ callId: 'call_abc', output: '{"status":"paid"}' }]);
    expect(socket.sentTypes().slice(-2)).toEqual(['conversation.item.create', 'response.create']);
    session.sendText('kal tak de dunga');
    expect(seen).toContain('customer:kal tak de dunga:null');
    expect(socket.sent.at(-2)).toMatchObject({
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'kal tak de dunga' }],
      },
    });
    session.say('Hello? "Kya" aap hain?');
    expect(socket.sent.at(-1)).toMatchObject({
      type: 'response.create',
      response: { instructions: expect.stringContaining("'Kya'") as string },
    });
    const pcm = Int16Array.from([1000, -1000, 0]);
    session.sendAudio(pcm);
    const appended = socket.sent.at(-1) as { audio: string };
    expect(Array.from(decodeMulaw(Buffer.from(appended.audio, 'base64')))).toHaveLength(3);
    socket.receive({
      type: 'response.output_audio.delta',
      item_id: 'i',
      delta: Buffer.from(encodeMulaw(pcm)).toString('base64'),
    });
    expect(audio.at(-1)).toHaveLength(3);
    for (const e of realtimeFixture('error')) socket.receive(e);
    expect(seen.filter((s) => s.startsWith('error'))).toEqual([
      'error:invalid_value:false',
      'error:server_error:false',
      'error:provider_error:false',
    ]);
    socket.emit('error', new Error('x'));
    socket.emit('close');
    expect(seen.slice(-2)).toEqual([
      'error:provider_socket_error:false',
      'error:provider_closed:true',
    ]);
    expect(
      RealtimeVoiceSession.sessionUpdate({ ...OPTIONS, rate: 8_000, language: 'hi' }, 'm', 't'),
    ).toMatchObject({
      session: {
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            transcription: { language: 'hi' },
            turn_detection: { interrupt_response: true },
          },
        },
      },
    });
  });

  it('connect timeout and errors; the provider retries the connect once', async () => {
    let timeout: (() => void) | null = null;
    const silent = new FakeSocket();
    const pending = openSocket('wss://x', {
      apiKey: 'k',
      connect: () => silent,
      setTimeout: (fn) => {
        timeout = fn;
        return 1;
      },
      clearTimeout: () => undefined,
    });
    (timeout as unknown as () => void)();
    await expect(pending).rejects.toThrow('realtime_connect_timeout');
    expect(silent.closedWith).toBe(1000);
    const failing = new FakeSocket();
    const failed = openSocket('wss://x', {
      apiKey: 'k',
      connect: () => {
        setImmediate(() => failing.emit('error', new Error('refused')));
        return failing;
      },
    });
    await expect(failed).rejects.toThrow('refused');
    let attempts = 0;
    const good = new FakeSocket();
    const provider = new RealtimeVoiceProvider({
      ...deps(good),
      connect: (url, headers) => {
        attempts += 1;
        if (attempts === 1) {
          const bad = new FakeSocket();
          setImmediate(() => bad.emit('error', new Error('first')));
          return bad;
        }
        return deps(good).connect(url, headers);
      },
    });
    const session = await provider.open(OPTIONS);
    expect(attempts).toBe(2);
    expect(session.kind).toBe('realtime');
    expect(provider).toMatchObject({ name: 'openai', pipeline: 'realtime' });
  });
});

const fetchStub = (responses: ({ status: number; body?: Buffer } | 'throw')[]) => {
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  const fn: FetchLike = (url, init) => {
    calls.push({ url, body: init.body, headers: init.headers });
    const next = responses.shift() ?? 'throw';
    if (next === 'throw') return Promise.reject(new Error('network'));
    return Promise.resolve({
      ok: next.status < 300,
      status: next.status,
      arrayBuffer: () => {
        const b = next.body ?? Buffer.alloc(0);
        return Promise.resolve(
          b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer,
        );
      },
    });
  };
  return { fn, calls };
};

describe('OpenAiTts', () => {
  const pcm = Int16Array.from([5, -5, 7]);
  const make = (f: FetchLike) =>
    new OpenAiTts({
      apiKey: 'k',
      baseUrl: 'https://api.example.test/v1/',
      model: 'gpt-4o-mini-tts',
      fetch: f,
    });

  it('posts the request and returns PCM; retries one 5xx / network failure', async () => {
    const ok = fetchStub([{ status: 200, body: toBytes(pcm) }]);
    const tts = make(ok.fn);
    expect(tts.model).toBe('gpt-4o-mini-tts');
    expect(
      Array.from(
        await tts.synthesize({
          text: 'Namaste',
          voice: 'coral',
          language: 'hinglish',
          tone: 'calm',
        }),
      ),
    ).toEqual([5, -5, 7]);
    expect(ok.calls[0]?.url).toBe('https://api.example.test/v1/audio/speech');
    expect(JSON.parse(ok.calls[0]?.body ?? '{}')).toMatchObject({
      model: 'gpt-4o-mini-tts',
      voice: 'coral',
      input: 'Namaste',
      response_format: 'pcm',
      instructions: expect.stringContaining('Hinglish') as string,
    });
    expect(ok.calls[0]?.headers.Authorization).toBe('Bearer k');
    const retry = fetchStub([{ status: 503 }, { status: 200, body: toBytes(pcm) }]);
    expect(await make(retry.fn).synthesize({ text: 'x', voice: 'v', language: 'xx' })).toHaveLength(
      3,
    );
    const net = fetchStub(['throw', { status: 200, body: toBytes(pcm) }]);
    expect(await make(net.fn).synthesize({ text: 'x', voice: 'v', language: 'en' })).toHaveLength(
      3,
    );
  });

  it('gives up after a second failure; client errors are not retried', async () => {
    await expect(
      make(fetchStub([{ status: 500 }, { status: 502 }]).fn).synthesize({
        text: 'x',
        voice: 'v',
        language: 'hi',
      }),
    ).rejects.toThrow(TtsError);
    const bad = fetchStub([{ status: 400 }]);
    await expect(
      make(bad.fn).synthesize({ text: 'x', voice: 'v', language: 'hi' }),
    ).rejects.toMatchObject({ code: 'http_400' });
    expect(bad.calls).toHaveLength(1);
    await expect(
      make(fetchStub(['throw', 'throw']).fn).synthesize({ text: 'x', voice: 'v', language: 'hi' }),
    ).rejects.toMatchObject({ code: 'network' });
  });
});

describe('OpenAiStt', () => {
  it('opens a transcription session and emits speech + final events', async () => {
    const socket = new FakeSocket();
    const args: unknown[] = [];
    socket.on('connect-args', (...a: unknown[]) => args.push(...a));
    const stt = new OpenAiStt(deps(socket));
    const session = await stt.open({ language: 'hi', rate: 24_000 });
    expect(args[0]).toBe('wss://api.example.test/v1/realtime?intent=transcription');
    expect(socket.sent[0]).toMatchObject({
      type: 'session.update',
      session: { type: 'transcription', audio: { input: { transcription: { language: 'hi' } } } },
    });
    const seen: string[] = [];
    session.on('speech_started', () => seen.push('start'));
    session.on('speech_stopped', () => seen.push('stop'));
    session.on('final', (e) => seen.push(`final:${e.text}:${String(e.language)}`));
    session.on('error', (e) => seen.push(`error:${e.code}:${String(e.fatal)}`));
    socket.receive({ type: 'input_audio_buffer.speech_started' });
    socket.receive({ type: 'input_audio_buffer.speech_stopped' });
    socket.receive({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'haan',
    });
    socket.receive({ type: 'error', error: { code: 'bad' } });
    socket.receive({ type: 'error', error: {} });
    socket.receive({ type: 'session.updated' });
    session.sendText('typed');
    session.sendAudio(new Int16Array(2));
    expect(socket.sent.at(-1)).toMatchObject({ type: 'input_audio_buffer.append' });
    socket.emit('error', new Error('x'));
    socket.emit('close');
    expect(seen).toEqual([
      'start',
      'stop',
      'final:haan:null',
      'error:bad:false',
      'error:provider_error:false',
      'start',
      'stop',
      'final:typed:null',
      'error:provider_socket_error:false',
      'error:provider_closed:true',
    ]);
    const count = socket.sent.length;
    session.sendAudio(new Int16Array(2));
    expect(socket.sent).toHaveLength(count);
    const s8 = await new OpenAiStt(deps(new FakeSocket())).open({ language: null, rate: 8_000 });
    s8.sendAudio(new Int16Array(2));
    await s8.close();
    await s8.close();
    await session.close();
  });
});

describe('fake TTS / STT', () => {
  it('fake TTS: 60 ms per character within 0.3–20 s', async () => {
    expect(fakeTtsMs('')).toBe(300);
    expect(fakeTtsMs('x'.repeat(10))).toBe(600);
    expect(fakeTtsMs('x'.repeat(1000))).toBe(20_000);
    const tts = new FakeTts();
    expect(await tts.synthesize({ text: 'abcde', voice: 'v', language: 'hi' })).toHaveLength(7200);
    expect(tts.spoken).toEqual(['abcde']);
  });

  it('fake STT: typed words are finals; mic energy gives empty finals', async () => {
    const stt = (await new FakeStt().open()) as FakeSttSession;
    const seen: string[] = [];
    stt.on('speech_started', () => seen.push('start'));
    stt.on('speech_stopped', () => seen.push('stop'));
    stt.on('final', (e) => seen.push(`final:${e.text}`));
    stt.sendText('kal tak');
    const loud = new Int16Array(480).fill(8000);
    for (let i = 0; i < 3; i += 1) stt.sendAudio(loud);
    for (let i = 0; i < 25; i += 1) stt.sendAudio(new Int16Array(480));
    expect(seen).toEqual(['start', 'stop', 'final:kal tak', 'start', 'stop', 'final:']);
    await stt.close();
  });
});

describe('ChatVoiceSession', () => {
  const done = (text: string, extra: Partial<TurnDone> = {}): TurnDone => ({
    text,
    outcome: {},
    ended: false,
    fallback: null,
    toolCalls: [],
    ...extra,
  });

  it('runs turns in order: words → turn → speech; silence is ignored', async () => {
    const tts = new FakeTts();
    const turn = vi.fn((text: string) =>
      Promise.resolve(done(`reply to ${text}`, { ended: text === 'bye' })),
    );
    const provider = new ChatVoiceProvider('fake', new FakeStt(), tts);
    const session = await provider.open({ ...OPTIONS, turn });
    const seen: string[] = [];
    session.on('customer_transcript', (e) => seen.push(`customer:${e.text}`));
    session.on('turn_done', (t) => seen.push(`turn:${t.text}:${String(t.ended)}`));
    session.on('bot_audio', (pcm) => seen.push(`audio:${String(pcm.length > 0)}`));
    session.on('bot_transcript', (e) => seen.push(`bot:${e.text}`));
    session.on('bot_done', () => seen.push('done'));
    session.on('speech_started', () => seen.push('start'));
    session.on('speech_stopped', () => seen.push('stop'));
    session.say('Namaste');
    session.sendText('hello');
    session.sendText('  ');
    session.sendText('bye');
    session.sendAudio(new Int16Array(480));
    session.submitToolResults();
    session.truncate();
    await vi.waitFor(() => expect(seen.filter((s) => s === 'done')).toHaveLength(3));
    expect(seen).toEqual([
      'start',
      'stop',
      'customer:hello',
      'start',
      'stop',
      'start',
      'stop',
      'customer:bye',
      'audio:true',
      'bot:Namaste',
      'done',
      'turn:reply to hello:false',
      'audio:true',
      'bot:reply to hello',
      'done',
      'turn:reply to bye:true',
      'audio:true',
      'bot:reply to bye',
      'done',
    ]);
    expect(turn).toHaveBeenCalledTimes(2);
    expect(session.kind).toBe('chat');
    await session.close();
  });

  it('empty replies end at once; turn / TTS failures become errors; closed sessions stay quiet', async () => {
    const failingTts = new FakeTts();
    failingTts.synthesize = () => {
      const err = new Error('tts down');
      err.name = 'TtsError';
      return Promise.reject(err);
    };
    let fail = true;
    const session = await new ChatVoiceProvider('fake', new FakeStt(), failingTts).open({
      ...OPTIONS,
      turn: () => (fail ? Promise.reject(new Error('model down')) : Promise.resolve(done(''))),
    });
    const seen: string[] = [];
    session.on('error', (e) => seen.push(e.code));
    session.on('bot_done', () => seen.push('done'));
    session.sendText('one');
    await vi.waitFor(() => expect(seen).toEqual(['ai_failed']));
    fail = false;
    session.sendText('two');
    await vi.waitFor(() => expect(seen).toEqual(['ai_failed', 'done']));
    session.say('x');
    await vi.waitFor(() => expect(seen).toEqual(['ai_failed', 'done', 'tts_failed']));
    const slow = await new ChatVoiceProvider('fake', new FakeStt(), new FakeTts()).open({
      ...OPTIONS,
      turn: () => new Promise((resolve) => setTimeout(() => resolve(done('late')), 5)),
    });
    const late: string[] = [];
    slow.on('turn_done', () => late.push('turn'));
    slow.sendText('hi');
    await slow.close();
    await new Promise((r) => setTimeout(r, 20));
    expect(late).toEqual([]);
    await expect(
      new ChatVoiceProvider('fake', new FakeStt(), new FakeTts()).open(OPTIONS),
    ).rejects.toThrow('turn function');
    const failingSay = await new ChatVoiceProvider('fake', new FakeStt(), {
      name: 'fake',
      model: 'x',
      synthesize: () => Promise.reject(new Error('boom')),
    }).open({ ...OPTIONS, turn: () => Promise.resolve(done('x')) });
    const errs: string[] = [];
    failingSay.on('error', (e) => errs.push(e.code));
    failingSay.say('x');
    await vi.waitFor(() => expect(errs).toEqual(['ai_failed']));
    const closedSay = await new ChatVoiceProvider('fake', new FakeStt(), new FakeTts()).open({
      ...OPTIONS,
      turn: () => Promise.resolve(done('x')),
    });
    const after: string[] = [];
    closedSay.on('bot_audio', () => after.push('audio'));
    closedSay.say('x');
    await closedSay.close();
    await new Promise((r) => setTimeout(r, 5));
    expect(after).toEqual([]);
  });

  it('forwards STT errors', () => {
    const stt = new FakeSttSession();
    const session = new ChatVoiceSession(stt, new FakeTts(), {
      ...OPTIONS,
      turn: () => Promise.resolve(done('x')),
    });
    const errs: string[] = [];
    session.on('error', (e) => errs.push(e.code));
    (stt as unknown as { emit: (n: string, e: unknown) => void }).emit('error', {
      code: 'stt_down',
      fatal: true,
    });
    expect(errs).toEqual(['stt_down']);
  });
});

describe('createVoiceProviders', () => {
  it('fake by default; openai realtime or chat pipeline with a key', () => {
    const fake = createVoiceProviders(loadEnv({}));
    expect(fake).toMatchObject({ name: 'fake', textInput: true });
    expect(fake.ai).toMatchObject({ name: 'fake', pipeline: 'chat' });
    expect(fake.tts.name).toBe('fake');
    expect(fake.stt.name).toBe('fake');
    const real = createVoiceProviders(
      loadEnv({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'k', VOICE_TEXT_INPUT_ENABLED: 'false' }),
    );
    expect(real).toMatchObject({ name: 'openai', textInput: false });
    expect(real.ai.pipeline).toBe('realtime');
    expect(real.tts.model).toBe('gpt-4o-mini-tts');
    const chat = createVoiceProviders(
      loadEnv({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'k', VOICE_PIPELINE: 'chat' }),
      { fetch: fetchStub([]).fn, connect: () => new FakeSocket() },
    );
    expect(chat.ai).toMatchObject({ name: 'openai', pipeline: 'chat' });
    const noKey = createVoiceProviders({ ...loadEnv({}), VOICE_PROVIDER: 'openai' });
    expect(noKey.name).toBe('openai');
    expect(typeof defaultSocketFactory).toBe('function');
  });
});

describe('provider edge cases', () => {
  it('emitter: several listeners, unsubscribe; sockets closed by us emit nothing', async () => {
    const socket = new FakeSocket();
    const session = new RealtimeVoiceSession(socket, OPTIONS);
    const a: string[] = [];
    const off = session.on('speech_started', () => a.push('a'));
    session.on('speech_started', () => a.push('b'));
    socket.receive({ type: 'input_audio_buffer.speech_started' });
    off();
    socket.receive({ type: 'input_audio_buffer.speech_started' });
    expect(a).toEqual(['a', 'b', 'b']);
    socket.receive({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'hello',
      language: 'en',
    });
    const errors: string[] = [];
    session.on('error', (e) => errors.push(e.code));
    await session.close();
    socket.emit('close');
    expect(errors).toEqual([]);
    const stt = await new OpenAiStt(deps(new FakeSocket())).open({ language: null, rate: 24_000 });
    const langs: (string | null)[] = [];
    stt.on('final', (e) => langs.push(e.language));
    const sttSocket = (stt as unknown as { socket: FakeSocket }).socket;
    sttSocket.receive({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'x',
      language: 'hi',
    });
    expect(langs).toEqual(['hi']);
    await stt.close();
    sttSocket.emit('close');
  });

  it('a non-Error turn failure is still an AI failure; the default socket factory makes a ws', async () => {
    const session = await new ChatVoiceProvider('fake', new FakeStt(), new FakeTts()).open({
      ...OPTIONS,
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      turn: () => Promise.reject('nope'),
    });
    const errs: string[] = [];
    session.on('error', (e) => errs.push(e.code));
    session.sendText('x');
    await vi.waitFor(() => expect(errs).toEqual(['ai_failed']));
    const ws = defaultSocketFactory('ws://127.0.0.1:9/never', {});
    ws.on('error', () => undefined);
    ws.close();
  });
});

describe('provider edge cases (2)', () => {
  it('transcripts without a language; a turn failing after close stays quiet', async () => {
    const socket = new FakeSocket();
    const session = new RealtimeVoiceSession(socket, OPTIONS);
    const langs: (string | null)[] = [];
    session.on('customer_transcript', (e) => langs.push(e.language));
    socket.receive({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'x',
    });
    expect(langs).toEqual([null]);
    let reject: (err: Error) => void = () => undefined;
    const chat = await new ChatVoiceProvider('fake', new FakeStt(), new FakeTts()).open({
      ...OPTIONS,
      turn: () => new Promise((_resolve, rej) => (reject = rej)),
    });
    const errs: string[] = [];
    chat.on('error', (e) => errs.push(e.code));
    chat.sendText('x');
    await chat.close();
    reject(new Error('late'));
    await new Promise((r) => setTimeout(r, 5));
    expect(errs).toEqual([]);
  });
});
