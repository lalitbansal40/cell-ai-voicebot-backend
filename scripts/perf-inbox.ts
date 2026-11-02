/**
 * DEV ONLY — Meta webhook burst (Phase 16, T16.8).
 *   npm run perf:inbox                 (500 events / s for 2 min)
 *   npm run perf:inbox -- 100 30       (100 events / s for 30 s)
 * Signed customer texts, on the fake Meta, through the real API and worker. Target: 0 lost,
 * 0 duplicates, drained within 2 min, API p95 < 300 ms. See perf-common.ts for what it touches.
 */
import { performance } from 'node:perf_hooks';

import { getEnv } from '../src/config/env';
import { metaAppSecret, signWebhook } from '../src/core/meta';
import { MessageModel } from '../src/db/models/message.model';
import { MetaWebhookEventModel } from '../src/db/models/meta-webhook-event.model';

import { BASE, percentile, report, seedWorld, sleep, startPerf, uid } from './perf-common';

const TARGET_P95_MS = 300;
const DRAIN_MS = 120_000;
/** Keep watching past the target, so a slow drain isn't reported as lost events. */
const WATCH_MS = 900_000;

const main = async () => {
  const rate = Number(process.argv[2] ?? 500);
  const seconds = Number(process.argv[3] ?? 120);
  const secret = metaAppSecret(getEnv());
  const run = await startPerf();
  try {
    const w = await seedWorld((b) => signWebhook(b, secret));
    const url = `${BASE}/api/v1/webhooks/meta`;
    const tag = uid();
    const latencies: number[] = [];
    const statuses = new Map<number, number>();
    const inFlight = new Set<Promise<void>>();
    const total = rate * seconds;
    console.info(`Posting ${String(total)} signed events (${String(rate)} / s)…`);
    const start = performance.now();
    for (let i = 0; i < total; i += 1) {
      const due = start + (i / rate) * 1000;
      const wait = due - performance.now();
      if (wait > 1) await sleep(wait);
      const from = `9198${String(i % 5000).padStart(8, '0')}`;
      const body = JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: w.wabaId,
            time: Math.floor(Date.now() / 1000),
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    display_phone_number: '919000000010',
                    phone_number_id: w.phoneNumberId,
                  },
                  contacts: [{ wa_id: from, profile: { name: 'Perf' } }],
                  messages: [
                    {
                      from,
                      id: `wamid.PERF${tag}${String(i)}`,
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
      const t0 = performance.now();
      const p = fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': w.appSecretHeader(body),
        },
        body,
      })
        .then(async (res) => {
          await res.arrayBuffer();
          statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
          latencies.push(performance.now() - t0);
        })
        .catch(() => {
          statuses.set(0, (statuses.get(0) ?? 0) + 1);
        })
        .finally(() => {
          inFlight.delete(p);
        });
      inFlight.add(p);
    }
    await Promise.all(inFlight);
    const postSec = (performance.now() - start) / 1000;

    const drainStart = performance.now();
    let messages = 0;
    while (performance.now() - drainStart < WATCH_MS) {
      messages = await MessageModel.countDocuments({ accountId: w.accountId, direction: 'in' });
      if (messages >= total) break;
      await sleep(2_000);
    }
    const drainSec = (performance.now() - drainStart) / 1000;
    const distinct = await MessageModel.distinct('waMessageId', {
      accountId: w.accountId,
      direction: 'in',
    });
    const events = await MetaWebhookEventModel.countDocuments({ accountId: w.accountId });
    const p95 = percentile(latencies, 95);
    const accepted = statuses.get(200) ?? 0;
    const lost = total - messages;
    const duplicates = messages - distinct.length;
    console.info(`Posted in ${postSec.toFixed(1)} s; statuses ${JSON.stringify([...statuses])}`);
    console.info(
      `API latency p50 ${percentile(latencies, 50).toFixed(0)} ms, p95 ${p95.toFixed(0)} ms (target < ${String(TARGET_P95_MS)})`,
    );
    console.info(
      `Stored events ${String(events)}; messages ${String(messages)} / ${String(total)}, lost ${String(lost)}, duplicates ${String(duplicates)}, drained in ${drainSec.toFixed(1)} s`,
    );
    report(
      accepted === total &&
        lost === 0 &&
        duplicates === 0 &&
        p95 < TARGET_P95_MS &&
        drainSec * 1000 < DRAIN_MS,
    );
  } finally {
    await run.stop();
  }
};

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
