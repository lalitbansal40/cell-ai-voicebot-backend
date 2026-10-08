// Browser side of the PoC: mic → 24 kHz PCM16 → server; server audio → playback; barge-in clears playback.
const $ = (id) => document.getElementById(id);
let ws,
  ctx,
  micStream,
  workletNode,
  nextTime = 0;
const sources = new Set();
const latencies = [];

const log = (cls, text) => {
  const row = document.createElement('div');
  row.className = `row ${cls}`;
  row.textContent = text;
  $('log').appendChild(row);
  $('log').scrollTop = $('log').scrollHeight;
};

const floatToPcm16 = (f32) => {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i += 1) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
};

const play = (arrayBuffer) => {
  const pcm = new Int16Array(arrayBuffer);
  const buf = ctx.createBuffer(1, pcm.length, 24000);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < pcm.length; i += 1) ch[i] = pcm[i] / 0x8000;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  nextTime = Math.max(nextTime, ctx.currentTime + 0.02);
  src.start(nextTime);
  nextTime += buf.duration;
  sources.add(src);
  src.onended = () => sources.delete(src);
};

const clearPlayback = () => {
  for (const s of sources) {
    try {
      s.stop();
    } catch {}
  }
  sources.clear();
  nextTime = 0;
};

const start = async () => {
  $('start').disabled = true;
  ctx = new AudioContext({ sampleRate: 24000 });
  await ctx.audioWorklet.addModule('/mic-worklet.js');
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const params = new URLSearchParams(
    ['mode', 'model', 'voice', 'payment', 'name', 'amount', 'days'].map((k) => [k, $(k).value]),
  );
  ws = new WebSocket(`ws://${location.host}/ws?${params}`);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return play(ev.data);
    const msg = JSON.parse(ev.data);
    if (msg.type === 'ready')
      log(
        'tool',
        `Connected: ${msg.model} · ${msg.mode} · ${msg.voice} (PoC spend so far $${msg.spentUsd.toFixed(4)})`,
      );
    if (msg.type === 'customer') log('customer', `You: ${msg.text}`);
    if (msg.type === 'bot') log('bot', `Bot: ${msg.text}`);
    if (msg.type === 'tool')
      log('tool', `tool ${msg.name}(${msg.arguments}) → ${JSON.stringify(msg.result)}`);
    if (msg.type === 'clear') clearPlayback();
    if (msg.type === 'error') log('error', `Error: ${msg.message}`);
    if (msg.type === 'cost') $('cost').textContent = msg.usd.toFixed(4);
    if (msg.type === 'latency') {
      latencies.push(msg.ms);
      $('lat').textContent = msg.ms;
      $('avg').textContent = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
    }
  };
  ws.onclose = () => {
    log('tool', 'Call ended.');
    stop();
  };
  const source = ctx.createMediaStreamSource(micStream);
  workletNode = new AudioWorkletNode(ctx, 'mic-capture');
  workletNode.port.onmessage = (e) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(floatToPcm16(e.data).buffer);
  };
  source.connect(workletNode);
  $('stop').disabled = false;
};

const stop = () => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  if (workletNode) workletNode.disconnect();
  clearPlayback();
  if (ctx && ctx.state !== 'closed') ctx.close();
  $('start').disabled = false;
  $('stop').disabled = true;
};

$('start').onclick = () =>
  start().catch((err) => {
    log('error', err.message);
    stop();
  });
$('stop').onclick = stop;
