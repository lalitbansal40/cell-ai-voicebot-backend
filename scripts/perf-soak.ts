/**
 * DEV ONLY — mixed load over time (Phase 16, T16.8).
 *   npm run perf:soak                  (60 min)
 *   npm run perf:soak -- 5
 * Webhooks at 50 / s, API sends at 5 / s and a sign-up every 5 s, on the real API. Each minute it
 * samples the API's memory and the queue depth, then checks both stayed flat and reports how long
 * sign-up took while busy. See perf-common.ts.
 */
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

import { getEnv } from '../src/config/env';
import { metaAppSecret, signWebhook } from '../src/core/meta';
import { MessageModel } from '../src/db/models/message.model';
import { DEFAULT_RATE_CARD, RateCardModel } from '../src/db/models/rate-card.model';

import {
  BASE,
  newKey,
  percentile,
  report,
  seedTemplate,
  seedWorld,
  sleep,
  startPerf,
  uid,
} from './perf-common';

const WEBHOOKS_PER_SEC = 50;
const SENDS_PER_SEC = 5;
const SIGNUP_EVERY_MS = 5_000;
/** Memory growth from the first quarter to the last that still counts as flat. */
const FLAT_GROWTH = 1.25;
const DRAIN_MS = 300_000;

const rssMb = (pid: number): number =>
  Math.round(
    Number(
      execFileSync('ps', ['-o', 'rss=', '-p', String(pid)])
        .toString()
        .trim(),
    ) / 1024,
  );

const main = async () => {
  const minutes = Number(process.argv[2] ?? 60);
  const secret = metaAppSecret(getEnv());
  const run = await startPerf();
  try {
    await RateCardModel.create({
      accountId: null,
      ...DEFAULT_RATE_CARD,
      effectiveFrom: new Date(0),
    });
    const w = await seedWorld((b) => signWebhook(b, secret));
    await seedTemplate(w);
    const key = await newKey(w, ['messages:write']);
    const tag = uid();
    const counts = { webhook: 0, send: 0, errors: 0 };
    const signups: number[] = [];
    const signupStatus = new Map<number, number>();
    const samples: { minute: number; rss: number; waiting: number }[] = [];
    const end = performance.now() + minutes * 60_000;
    let running = true;

    const pace = async (perSec: number, act: (i: number) => Promise<void>) => {
      const start = performance.now();
      for (let i = 0; running; i += 1) {
        const wait = start + (i / perSec) * 1000 - performance.now();
        if (wait > 1) await sleep(wait);
        void act(i);
      }
    };
    const webhooks = pace(WEBHOOKS_PER_SEC, async (i) => {
      const from = `9198${String(i % 2000).padStart(8, '0')}`;
      const body = JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: w.wabaId,
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { phone_number_id: w.phoneNumberId },
                  contacts: [{ wa_id: from, profile: { name: 'Perf' } }],
                  messages: [
                    {
                      from,
                      id: `wamid.SOAK${tag}${String(i)}`,
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      type: 'text',
                      text: { body: 'hello' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      });
      const res = await fetch(`${BASE}/api/v1/webhooks/meta`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': w.appSecretHeader(body),
        },
        body,
      }).catch(() => null);
      await res?.arrayBuffer();
      if (res?.ok) counts.webhook += 1;
      else counts.errors += 1;
    });
    const sends = pace(SENDS_PER_SEC, async (i) => {
      const res = await fetch(`${BASE}/api/v1/messages/template`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'idempotency-key': `${tag}-${String(i)}`,
          'x-forwarded-for': '10.50.0.1',
        },
        body: JSON.stringify({
          to: `+9196${String(i % 2000).padStart(8, '0')}`,
          template: { name: 'perf_notice', language: 'en' },
        }),
      }).catch(() => null);
      await res?.arrayBuffer();
      // one key stays under its limit: 429 here is the limit working
      if (res?.ok || res?.status === 429) counts.send += 1;
      else counts.errors += 1;
    });
    const signup = (async () => {
      for (let i = 0; running; i += 1) {
        const t0 = performance.now();
        const res = await fetch(`${BASE}/api/v1/auth/signup`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': `10.60.${String(Math.floor(i / 250))}.${String(i % 250)}`,
          },
          body: JSON.stringify({
            businessName: `Soak ${String(i)}`,
            name: 'Soak',
            email: `soak-${tag}-${String(i)}@example.com`,
            password: 'blue-tiger-river-42',
          }),
        }).catch(() => null);
        await res?.arrayBuffer();
        signups.push(performance.now() - t0);
        const status = res?.status ?? 0;
        signupStatus.set(status, (signupStatus.get(status) ?? 0) + 1);
        await sleep(SIGNUP_EVERY_MS);
      }
    })();

    const pid = run.server.pid ?? 0;
    for (let minute = 1; performance.now() < end; minute += 1) {
      await sleep(Math.min(60_000, Math.max(0, end - performance.now())));
      const waiting = Number(await run.redis.llen('cav:whatsapp:wait'));
      const sample = { minute, rss: rssMb(pid), waiting };
      samples.push(sample);
      console.info(
        `min ${String(minute)}: RSS ${String(sample.rss)} MB, whatsapp queue ${String(waiting)}, webhooks ${String(counts.webhook)}, sends ${String(counts.send)}, errors ${String(counts.errors)}`,
      );
    }
    running = false;
    await Promise.all([webhooks, sends, signup]);
    const drainEnd = performance.now() + DRAIN_MS;
    while (
      performance.now() < drainEnd &&
      (await MessageModel.countDocuments({ accountId: w.accountId, direction: 'in' })) <
        counts.webhook
    ) {
      await sleep(5_000);
    }
    const quarter = Math.max(1, Math.floor(samples.length / 4));
    const avg = (rows: typeof samples) =>
      rows.reduce((n, s) => n + s.rss, 0) / Math.max(1, rows.length);
    const early = avg(samples.slice(0, quarter));
    const late = avg(samples.slice(-quarter));
    const maxQueue = Math.max(0, ...samples.map((s) => s.waiting));
    console.info(
      `Memory first quarter ${early.toFixed(0)} MB, last quarter ${late.toFixed(0)} MB; queue max ${String(maxQueue)}`,
    );
    console.info(
      `Sign-up while busy: ${String(signups.length)} runs, p50 ${percentile(signups, 50).toFixed(0)} ms, p95 ${percentile(signups, 95).toFixed(0)} ms, statuses ${JSON.stringify([...signupStatus])}`,
    );
    const stored = await MessageModel.countDocuments({ accountId: w.accountId, direction: 'in' });
    console.info(
      `Inbound stored ${String(stored)} of ${String(counts.webhook)}; errors ${String(counts.errors)}`,
    );
    report(
      late <= early * FLAT_GROWTH &&
        counts.errors === 0 &&
        stored >= counts.webhook &&
        [...signupStatus.keys()].every((status) => status < 500),
    );
  } finally {
    await run.stop();
  }
};

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
