/**
 * DEV ONLY — public API under load (Phase 16, T16.8).
 *   npm run perf:api -- messages            (50 / s for 60 s across 50 keys, fake Meta)
 *   npm run perf:api -- calls               (50 / s for 60 s on the dry-run line)
 *   npm run perf:api -- messages 10 20
 * Target: p95 < 500 ms. Messages: 0 double charges, wallet balances with the ledger. Calls: over
 * capacity a clear 429 and never a 500; calls and holds reconcile. See perf-common.ts.
 */
import { performance } from 'node:perf_hooks';

import { Types } from 'mongoose';

import { getEnv } from '../src/config/env';
import { metaAppSecret, signWebhook } from '../src/core/meta';
import { CallModel } from '../src/db/models/call.model';
import { ContactModel } from '../src/db/models/contact.model';
import { LedgerEntryModel } from '../src/db/models/ledger-entry.model';
import { MessageModel } from '../src/db/models/message.model';
import { DEFAULT_RATE_CARD, RateCardModel } from '../src/db/models/rate-card.model';
import { WalletModel } from '../src/db/models/wallet.model';

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
  type PerfWorld,
} from './perf-common';

const TARGET_P95_MS = 500;
const KEYS = 50;

const seedFlow = async (w: PerfWorld) => {
  const api = async (method: string, path: string, body: object) => {
    const res = await fetch(`${BASE}/api/v1${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${w.ownerToken}`,
        'x-forwarded-for': '10.200.0.1',
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { data: Record<string, unknown> };
    if (!res.ok) throw new Error(`${path}: ${String(res.status)} ${JSON.stringify(json)}`);
    return json.data;
  };
  const agent = await api('POST', '/agents', {
    name: 'Perf',
    templateKey: 'loan_recovery_hinglish',
  });
  const flow = await api('POST', '/flows', {
    name: 'Perf',
    templateKey: 'loan_recovery',
    agentIds: { ai: agent.id },
  });
  await api('POST', `/flows/${String(flow.id)}/publish`, { revision: 1 });
  return String(flow.id);
};

const main = async () => {
  const kind = process.argv[2] ?? 'messages';
  if (kind !== 'messages' && kind !== 'calls') throw new Error('Usage: perf:api -- messages|calls');
  const rate = Number(process.argv[3] ?? 50);
  const seconds = Number(process.argv[4] ?? 60);
  const secret = metaAppSecret(getEnv());
  const run = await startPerf({ DRY_RUN_MAX_SPEED: '100' });
  try {
    if (!(await RateCardModel.exists({ accountId: null }))) {
      await RateCardModel.create({
        accountId: null,
        ...DEFAULT_RATE_CARD,
        effectiveFrom: new Date(0),
      });
    }
    const w = await seedWorld((b) => signWebhook(b, secret));
    await seedTemplate(w);
    const scope = kind === 'messages' ? 'messages:write' : 'calls:write';
    const keys = await Promise.all(Array.from({ length: KEYS }, () => newKey(w, [scope])));
    const total = rate * seconds;
    let flowId = '';
    const contacts: Types.ObjectId[] = [];
    if (kind === 'calls') {
      flowId = await seedFlow(w);
      for (let i = 0; i < total; i += 1) contacts.push(new Types.ObjectId());
      await ContactModel.collection.insertMany(
        contacts.map((_id, i) => ({
          _id,
          accountId: w.accountId,
          phoneE164: `+9197${String(i).padStart(8, '0')}`,
          name: 'Perf',
          tags: [],
          listIds: [],
          variables: {},
          dnd: false,
          optedOutAt: null,
          deletedAt: null,
          source: { type: 'manual', importJobId: null },
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      );
    }
    const before = await WalletModel.findOne({ accountId: w.accountId }).lean();
    const ledgerBefore = await LedgerEntryModel.countDocuments({ accountId: w.accountId });
    const latencies: number[] = [];
    const statuses = new Map<number, number>();
    const firstError = new Map<number, string>();
    const inFlight = new Set<Promise<void>>();
    const tag = uid();
    console.info(`${kind}: ${String(total)} requests (${String(rate)} / s, ${String(KEYS)} keys)…`);
    const start = performance.now();
    for (let i = 0; i < total; i += 1) {
      const wait = start + (i / rate) * 1000 - performance.now();
      if (wait > 1) await sleep(wait);
      const path = kind === 'messages' ? '/messages/template' : '/calls';
      const body =
        kind === 'messages'
          ? {
              to: `+9196${String(i % 5000).padStart(8, '0')}`,
              template: { name: 'perf_notice', language: 'en' },
            }
          : { contactId: contacts[i]?.toString(), flowId };
      const t0 = performance.now();
      const p = fetch(`${BASE}/api/v1${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': keys[i % KEYS] ?? '',
          'idempotency-key': `${tag}-${String(i)}`,
          // one client address per key, as outside systems would have
          'x-forwarded-for': `10.100.${String(Math.floor((i % KEYS) / 250))}.${String(i % KEYS)}`,
        },
        body: JSON.stringify(body),
      })
        .then(async (res) => {
          const text = await res.text();
          statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
          if (res.status >= 400 && !firstError.has(res.status)) {
            firstError.set(res.status, text.slice(0, 180));
          }
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
    const p95 = percentile(latencies, 95);
    console.info(`Statuses ${JSON.stringify([...statuses])}`);
    for (const [status, text] of firstError) console.info(`First ${String(status)}: ${text}`);
    console.info(
      `Latency p50 ${percentile(latencies, 50).toFixed(0)} ms, p95 ${p95.toFixed(0)} ms (target < ${String(TARGET_P95_MS)})`,
    );
    const noFiveHundred = ![...statuses.keys()].some((s) => s >= 500 || s === 0);

    // let sends and calls finish, then check the money
    const until = Date.now() + 180_000;
    for (;;) {
      const live =
        kind === 'calls'
          ? await CallModel.countDocuments({
              accountId: w.accountId,
              status: { $in: ['queued', 'ringing', 'in_progress'] },
            })
          : await MessageModel.countDocuments({ accountId: w.accountId, status: 'queued' });
      if (live === 0 || Date.now() > until) break;
      await sleep(2_000);
    }
    // the fake Meta's delivery statuses settle the holds a little later
    let wallet = await WalletModel.findOne({ accountId: w.accountId }).lean();
    for (
      const stopAt = Date.now() + 180_000;
      (wallet?.holdMicros ?? 0) > 0 && Date.now() < stopAt;
    ) {
      await sleep(2_000);
      wallet = await WalletModel.findOne({ accountId: w.accountId }).lean();
    }
    await sleep(2_000);
    wallet = await WalletModel.findOne({ accountId: w.accountId }).lean();
    const entries = await LedgerEntryModel.collection
      .find({ accountId: w.accountId })
      .project<{
        amountMicros?: number;
        direction?: string;
        status?: string;
        holdId?: unknown;
        ref?: { id?: string };
      }>({ amountMicros: 1, direction: 1, status: 1, ref: 1, holdId: 1 })
      .toArray();
    const captured = entries.filter((e) => e.status === 'captured');
    const ledgerSum = captured.reduce(
      (n, e) => n + (e.direction === 'credit' ? 1 : -1) * (e.amountMicros ?? 0),
      0,
    );
    const charges = captured.filter((e) => e.direction === 'debit').map((e) => e.ref?.id ?? '');
    const doubles = charges.length - new Set(charges).size;
    const heldSum = entries
      .filter((e) => e.status === 'held')
      .reduce((n, e) => n + (e.amountMicros ?? 0), 0);
    const balances = wallet?.balanceMicros === ledgerSum && wallet.holdMicros === heldSum;
    console.info(
      `Wallet ${String(before?.balanceMicros)} → ${String(wallet?.balanceMicros)}, hold ${String(wallet?.holdMicros)}; ledger rows ${String(ledgerBefore)} → ${String(entries.length)}, Σ captured ${String(ledgerSum)}, Σ held ${String(heldSum)}; double charges ${String(doubles)}`,
    );
    const ok2xx = [...statuses.entries()]
      .filter(([s]) => s >= 200 && s < 300)
      .reduce((n, [, c]) => n + c, 0);
    console.info(`Accepted ${String(ok2xx)} / ${String(total)}`);
    report(
      p95 < TARGET_P95_MS &&
        noFiveHundred &&
        doubles === 0 &&
        balances &&
        (kind === 'calls' ? ok2xx > 0 : ok2xx === total),
    );
  } finally {
    await run.stop();
  }
};

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
