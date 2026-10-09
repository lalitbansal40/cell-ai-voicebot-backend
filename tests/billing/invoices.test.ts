import { existsSync } from 'node:fs';

import type { Job } from 'bullmq';
import { Types } from 'mongoose';
import request from 'supertest';
import { extractText } from 'unpdf';
import { describe, expect, it } from 'vitest';

import { nextInvoiceNumber } from '../../src/core/billing/invoice-number';
import { invoiceFileKey, renderInvoice } from '../../src/core/billing/invoice-render';
import { unavailableBillingJobs } from '../../src/core/billing/jobs';
import { creditTopup } from '../../src/core/billing/topup-credit';
import { processBillingJob } from '../../src/core/queues/workers/billing.worker';
import type { StorageProvider } from '../../src/core/storage';
import { InvoiceCounterModel } from '../../src/db/models/invoice-counter.model';
import {
  InvoiceModel,
  type InvoiceDoc,
  type InvoiceStatus,
} from '../../src/db/models/invoice.model';
import { TopupOrderModel } from '../../src/db/models/topup-order.model';
import { withTransaction } from '../../src/db/transaction';
import { assetPath } from '../../src/shared/assets';
import { createLogger } from '../../src/shared/logger';
import { createTestAccount, type TestUser } from '../helpers/auth';
import { recordingBillingJobs } from '../helpers/billing';
import { useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const sent = useCapturedEmail();
const storage = useTempStorage();
const app = buildTestApp({}, { storage });
const RUPEE = 1_000_000;
const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` });

const BUYER = {
  legalName: 'Buyer Finance Pvt Ltd',
  email: 'Billing@Buyer.example',
  addressLine1: '1 MI Road',
  addressLine2: null,
  city: 'Jaipur',
  stateCode: '08',
  pin: '302001',
  gstin: '08AAACB1234C1Z5',
};

let seq = 0;
const invoice = async (
  accountId: Types.ObjectId,
  { intra = false, status = 'rendering' }: { intra?: boolean; status?: InvoiceStatus } = {},
) => {
  seq += 1;
  const amounts = intra
    ? { cgstMicros: 9 * RUPEE, sgstMicros: 9 * RUPEE, igstMicros: 0 }
    : { cgstMicros: 0, sgstMicros: 0, igstMicros: 180 * RUPEE + 90_000 };
  const tax = intra ? 18 * RUPEE : 180 * RUPEE + 90_000;
  const base = intra ? 100 * RUPEE : 1000 * RUPEE + 500_000;
  const doc = await InvoiceModel.create({
    accountId,
    number: `CAV/26-27/${String(900_000 + seq).padStart(6, '0')}`,
    fy: '26-27',
    topupOrderId: new Types.ObjectId(),
    ledgerEntryId: new Types.ObjectId(),
    seller: {
      name: 'Cell AI Technologies Pvt Ltd',
      address: '5 Tech Park, Jaipur',
      gstin: '08AAACC1234D1Z3',
      stateCode: '08',
    },
    buyer: intra ? BUYER : { ...BUYER, stateCode: '27', city: 'Pune', gstin: null },
    placeOfSupply: intra
      ? { stateCode: '08', stateName: 'Rajasthan' }
      : { stateCode: '27', stateName: 'Maharashtra' },
    sacCode: '998431',
    amounts: { baseMicros: base, ...amounts, taxMicros: tax, totalMicros: base + tax },
    paymentId: `pay_${seq}`,
    issuedAt: new Date('2026-10-09T06:00:00Z'),
    status,
  });
  return doc.toObject({ transform: false });
};

const pdfText = async (key: string): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const c of await storage.get(key)) chunks.push(c as Buffer);
  expect(Buffer.concat(chunks).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  const { text } = await extractText(new Uint8Array(Buffer.concat(chunks)), { mergePages: true });
  return text.replace(/\s+/g, ' ');
};

const render = (i: InvoiceDoc, s: StorageProvider | undefined = storage, job?: never) =>
  renderInvoice(
    { accountId: i.accountId.toString(), invoiceId: i._id.toString() },
    { storage: s },
    job,
  );

describe('invoice PDF rendering', () => {
  it('finds the bundled fonts', () => {
    expect(existsSync(assetPath('fonts', 'NotoSans-Regular.ttf'))).toBe(true);
    expect(existsSync(assetPath('fonts', 'NotoSans-Bold.ttf'))).toBe(true);
  });

  it('renders an intra-state invoice with CGST + SGST and sends the receipt once', async () => {
    const t = await createTestAccount({ name: 'Intra Co' });
    const owner = await t.addUser('owner');
    const inv = await invoice(t.account._id, { intra: true });
    expect(await render(inv)).toEqual({ rendered: 1 });

    const stored = await InvoiceModel.findById(inv._id).select('+pdfFileKey').lean();
    expect(stored?.status).toBe('ready');
    expect(stored?.pdfFileKey).toBe(invoiceFileKey(inv));
    expect(stored?.pdfFileKey).not.toContain('CAV/');
    const text = await pdfText(invoiceFileKey(inv));
    expect(text).toContain('TAX INVOICE');
    expect(text).toContain(inv.number);
    expect(text).toContain('08AAACC1234D1Z3');
    expect(text).toContain('08AAACB1234C1Z5');
    expect(text).toContain('CGST');
    expect(text).toContain('SGST');
    expect(text).not.toContain('IGST');
    expect(text).toContain('Rupees One Hundred Eighteen Only');

    const receipts = sent.filter(
      (e) => e.template === 'wallet.receipt' && e.dedupeKey?.includes(inv._id.toString()),
    );
    expect(receipts.map((e) => e.to).sort()).toEqual(
      ['billing@buyer.example', owner.user.email.toLowerCase()].sort(),
    );
    expect(receipts[0]?.vars).toMatchObject({ invoiceNumber: inv.number, total: '₹118.00' });

    // re-render (e.g. a retried job) keeps the number and sends nothing new
    await render(inv);
    expect(
      sent.filter(
        (e) => e.template === 'wallet.receipt' && e.dedupeKey?.includes(inv._id.toString()),
      ),
    ).toHaveLength(2);
    expect((await InvoiceModel.findById(inv._id).lean())?.number).toBe(inv.number);
  });

  it('renders an inter-state invoice with IGST and amounts in words with paise', async () => {
    const t = await createTestAccount({ name: 'Inter Co' });
    const inv = await invoice(t.account._id);
    await render(inv);
    const text = await pdfText(invoiceFileKey(inv));
    expect(text).toContain('IGST');
    expect(text).not.toContain('CGST');
    expect(text).toContain('Maharashtra');
    expect(text).toContain('Rupees One Thousand One Hundred Eighty and Fifty Nine Paise Only');
    // buyer email + no owner (account without users) → one receipt
    expect(
      sent.filter(
        (e) => e.template === 'wallet.receipt' && e.dedupeKey?.includes(inv._id.toString()),
      ),
    ).toHaveLength(1);
  });

  it('marks the invoice failed only on the last attempt and never sends a receipt', async () => {
    const t = await createTestAccount({ name: 'Fail Co' });
    const inv = await invoice(t.account._id);
    // same storage, but every write fails
    const broken = Object.assign(Object.create(storage) as StorageProvider, {
      put: () => Promise.reject(new Error('disk full')),
    });
    await expect(
      render(inv, broken, { attemptsMade: 0, opts: { attempts: 3 } } as never),
    ).rejects.toThrow('disk full');
    expect((await InvoiceModel.findById(inv._id).lean())?.status).toBe('rendering');
    await expect(
      render(inv, broken, { attemptsMade: 2, opts: { attempts: 3 } } as never),
    ).rejects.toThrow('disk full');
    expect((await InvoiceModel.findById(inv._id).lean())?.status).toBe('failed');
    await expect(
      renderInvoice({ accountId: inv.accountId.toString(), invoiceId: inv._id.toString() }, {}),
    ).rejects.toThrow('needs file storage');
    expect(sent.some((e) => e.dedupeKey?.includes(inv._id.toString()))).toBe(false);

    // a later manual retry still succeeds and sends the receipt
    await render(inv);
    expect((await InvoiceModel.findById(inv._id).lean())?.status).toBe('ready');
    expect(sent.some((e) => e.dedupeKey?.includes(inv._id.toString()))).toBe(true);
  });

  it('runs through the billing worker as the invoice.render job', async () => {
    const t = await createTestAccount({ name: 'Worker Co' });
    const inv = await invoice(t.account._id);
    const run = processBillingJob({
      storage,
      jobs: unavailableBillingJobs,
      logger: createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
    });
    const job = {
      name: 'invoice.render',
      data: { accountId: inv.accountId.toString(), invoiceId: inv._id.toString() },
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as unknown as Job;
    await expect(run(job)).resolves.toEqual({ rendered: 1 });
    expect((await InvoiceModel.findById(inv._id).lean())?.status).toBe('ready');
  });

  it('ignores an invoice that no longer exists or belongs to another account', async () => {
    const t = await createTestAccount({ name: 'Ghost Co' });
    const inv = await invoice(t.account._id);
    await expect(
      renderInvoice(
        { accountId: new Types.ObjectId().toString(), invoiceId: inv._id.toString() },
        { storage },
      ),
    ).resolves.toEqual({ rendered: 0 });
  });
});

describe('invoice numbering', () => {
  const order = (accountId = new Types.ObjectId()) =>
    TopupOrderModel.create({
      accountId,
      provider: 'fake',
      providerOrderId: `order_${new Types.ObjectId().toString()}`,
      status: 'created',
      baseMicros: 100 * RUPEE,
      igstMicros: 18 * RUPEE,
      taxMicros: 18 * RUPEE,
      totalMicros: 118 * RUPEE,
      buyer: { ...BUYER, stateCode: '27', gstin: null },
      createdBy: new Types.ObjectId(),
    });
  const pay = () => ({
    id: `pay_${new Types.ObjectId().toString()}`,
    orderId: null,
    status: 'captured' as const,
    amountPaise: 11_800,
    currency: 'INR',
    errorDescription: null,
  });

  it('gives 20 parallel credits 20 consecutive numbers with no gaps', async () => {
    await InvoiceCounterModel.deleteMany({});
    const rec = recordingBillingJobs();
    const orders = await Promise.all(Array.from({ length: 20 }, () => order()));
    const results = await Promise.all(
      orders.map((o) =>
        creditTopup({ orderId: o._id, payment: pay(), actor: { type: 'system' }, jobs: rec.jobs }),
      ),
    );
    const numbers = results
      .map((r) => Number(r.invoice?.number.split('/')[2]))
      .sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(rec.queued.filter((q) => q.name === 'invoice.render')).toHaveLength(20);
  });

  it('consumes no number when the transaction aborts', async () => {
    const date = new Date();
    const before = await withTransaction((s) => nextInvoiceNumber(date, s));
    await expect(
      withTransaction(async (s) => {
        await nextInvoiceNumber(date, s);
        throw new Error('abort after numbering');
      }),
    ).rejects.toThrow('abort after numbering');
    const after = await withTransaction((s) => nextInvoiceNumber(date, s));
    expect(Number(after.number.split('/')[2])).toBe(Number(before.number.split('/')[2]) + 1);
  });
});

describe('invoices API', () => {
  let n = 0;
  const member = async (
    role: 'owner' | 'viewer' | 'agent' = 'owner',
  ): Promise<TestUser & { accountId: Types.ObjectId }> => {
    n += 1;
    const t = await createTestAccount({ name: `Inv Co ${n}` });
    return { ...(await t.addUser(role)), accountId: t.account._id };
  };

  it('lists newest first with the page meta and never exposes the file key', async () => {
    const u = await member();
    const a = await invoice(u.accountId, { status: 'ready' });
    const b = await invoice(u.accountId, { status: 'rendering' });
    await invoice(new Types.ObjectId(), { status: 'ready' });
    const res = await request(app).get('/api/v1/invoices?limit=10').set(auth(u));
    expect(res.status).toBe(200);
    const body = res.body as { data: { id: string; number: string }[]; meta: { total: number } };
    expect(body.data.map((i) => i.id)).toEqual([b._id.toString(), a._id.toString()]);
    expect(body.meta.total).toBe(2);
    expect(JSON.stringify(res.body)).not.toContain('pdfFileKey');

    const one = await request(app).get(`/api/v1/invoices/${a._id.toString()}`).set(auth(u));
    expect(one.status).toBe(200);
    expect((one.body as { data: { number: string; buyer: { gstin: string } } }).data).toMatchObject(
      {
        number: a.number,
      },
    );
  });

  it('returns a signed 15-minute link once ready, 409 before, 404 for another account', async () => {
    const u = await member();
    const other = await member();
    const inv = await invoice(u.accountId);
    const pending = await request(app)
      .get(`/api/v1/invoices/${inv._id.toString()}/download`)
      .set(auth(u));
    expect(pending.status).toBe(409);
    expect((pending.body as { error: { code: string } }).error.code).toBe('CONFLICT_INVALID_STATE');

    await render(inv);
    const res = await request(app)
      .get(`/api/v1/invoices/${inv._id.toString()}/download`)
      .set(auth(u));
    expect(res.status).toBe(200);
    const { url, expiresInSec } = (res.body as { data: { url: string; expiresInSec: number } })
      .data;
    expect(expiresInSec).toBe(900);
    const signed = new URL(url);
    const file = await request(app).get(`${signed.pathname}${signed.search}`).buffer(true);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('application/pdf');
    // tampered signature → refused
    const bad = await request(app).get(
      `${signed.pathname}${signed.search.replace(/sig=[^&]+/, 'sig=x')}`,
    );
    expect(bad.status).not.toBe(200);

    for (const path of ['', '/download']) {
      const res404 = await request(app)
        .get(`/api/v1/invoices/${inv._id.toString()}${path}`)
        .set(auth(other));
      expect(res404.status).toBe(404);
    }
    const bad422 = await request(app).get('/api/v1/invoices/not-an-id').set(auth(u));
    expect(bad422.status).toBe(422);
  });

  it('needs wallet.read and a login', async () => {
    const agent = await member('agent');
    const res = await request(app).get('/api/v1/invoices').set(auth(agent));
    expect(res.status).toBe(403);
    expect((await request(app).get('/api/v1/invoices')).status).toBe(401);
  });

  it('409s when the app has no storage', async () => {
    const u = await member();
    const inv = await invoice(u.accountId, { status: 'ready' });
    await InvoiceModel.updateOne({ _id: inv._id }, { $set: { pdfFileKey: 'x.pdf' } });
    const bare = buildTestApp();
    const res = await request(bare)
      .get(`/api/v1/invoices/${inv._id.toString()}/download`)
      .set(auth(u));
    expect(res.status).toBe(409);
  });
});
