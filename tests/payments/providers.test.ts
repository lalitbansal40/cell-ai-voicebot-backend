import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BILLING_LIMITS } from '../../src/config/limits';
import {
  createFakePaymentProvider,
  createPaymentProvider,
  createRazorpayProvider,
  hmacHex,
  safeEqualHex,
} from '../../src/core/payments';
import type { AppError } from '../../src/shared/errors/app-error';

interface Seen {
  method: string;
  url: string;
  auth: string;
  body: unknown;
}
const seen: Seen[] = [];
let mode: 'ok' | '400' | '500' | 'slow' | 'html' = 'ok';
let server: Server;
let baseUrl = '';

const readBody = (req: IncomingMessage) =>
  new Promise<unknown>((resolve) => {
    let data = '';
    req.on('data', (c: Buffer) => (data += c.toString()));
    req.on('end', () => resolve(data ? (JSON.parse(data) as unknown) : null));
  });

beforeAll(async () => {
  server = createServer((req, res) => {
    void (async () => {
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        auth: req.headers.authorization ?? '',
        body: await readBody(req),
      });
      if (mode === 'slow') return; // never answers → client timeout
      res.setHeader('content-type', 'application/json');
      if (mode === '500') return res.writeHead(502).end('{}');
      if (mode === '400')
        return res
          .writeHead(400)
          .end(JSON.stringify({ error: { code: 'BAD_REQUEST_ERROR', description: 'nope' } }));
      if (mode === 'html') return res.writeHead(200).end('<html>');
      if (req.url === '/orders')
        return res.end(JSON.stringify({ id: 'order_123', status: 'created' }));
      if (req.url?.endsWith('/capture')) {
        return res.end(
          JSON.stringify({
            id: 'pay_1',
            order_id: 'order_123',
            status: 'captured',
            amount: 118000,
            currency: 'INR',
          }),
        );
      }
      return res.end(
        JSON.stringify({
          id: 'pay_1',
          order_id: 'order_123',
          status: 'authorized',
          amount: 118000,
          currency: 'INR',
          error_description: null,
        }),
      );
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const rzp = () =>
  createRazorpayProvider({
    keyId: 'rzp_test_k',
    keySecret: 'key-secret',
    webhookSecret: 'hook-secret',
    baseUrl,
  });

describe('razorpay provider', () => {
  it('creates orders in paise with Basic auth and a ≤ 40 char receipt', async () => {
    mode = 'ok';
    const order = await rzp().createOrder({
      amountPaise: 118000,
      receipt: 'x'.repeat(60),
      notes: { a: '1' },
    });
    expect(order).toEqual({ id: 'order_123', status: 'created' });
    const req = seen.at(-1);
    expect(req?.method).toBe('POST');
    expect(req?.auth).toBe(`Basic ${Buffer.from('rzp_test_k:key-secret').toString('base64')}`);
    expect(req?.body).toEqual({
      amount: 118000,
      currency: 'INR',
      receipt: 'x'.repeat(40),
      notes: { a: '1' },
    });
  });

  it('fetches and captures payments', async () => {
    mode = 'ok';
    const p = await rzp().fetchPayment('pay_1');
    expect(p).toEqual({
      id: 'pay_1',
      orderId: 'order_123',
      status: 'authorized',
      amountPaise: 118000,
      currency: 'INR',
      errorDescription: null,
    });
    expect(seen.at(-1)?.url).toBe('/payments/pay_1');
    const c = await rzp().capturePayment('pay_1', 118000);
    expect(c.status).toBe('captured');
    expect(seen.at(-1)?.body).toEqual({ amount: 118000, currency: 'INR' });
  });

  it('maps errors: 4xx → PROVIDER_ERROR, 5xx / bad JSON / timeout → PROVIDER_UNAVAILABLE', async () => {
    const code = async () =>
      (await rzp()
        .fetchPayment('pay_1')
        .catch((e: unknown) => e)) as AppError;
    mode = '400';
    expect((await code()).code).toBe('PROVIDER_ERROR');
    mode = '500';
    expect((await code()).code).toBe('PROVIDER_UNAVAILABLE');
    mode = 'html';
    expect((await code()).code).toBe('PROVIDER_ERROR');
    mode = 'slow';
    const limits = BILLING_LIMITS as { providerTimeoutMs: number };
    const before = limits.providerTimeoutMs;
    limits.providerTimeoutMs = 100;
    try {
      expect((await code()).code).toBe('PROVIDER_UNAVAILABLE');
    } finally {
      limits.providerTimeoutMs = before;
      mode = 'ok';
    }
  });

  it('verifies checkout and webhook signatures in constant time', () => {
    const p = rzp();
    const good = hmacHex('key-secret', 'order_123|pay_1');
    expect(p.verifyCheckoutSignature('order_123', 'pay_1', good)).toBe(true);
    expect(p.verifyCheckoutSignature('order_123', 'pay_2', good)).toBe(false);
    expect(p.verifyCheckoutSignature('order_123', 'pay_1', 'short')).toBe(false);
    const body = Buffer.from('{"event":"payment.captured"}');
    expect(p.verifyWebhookSignature(body, hmacHex('hook-secret', body))).toBe(true);
    expect(p.verifyWebhookSignature(body, hmacHex('key-secret', body))).toBe(false);
    expect(safeEqualHex('ab', 'abc')).toBe(false);
  });
});

describe('fake provider', () => {
  it('creates orders and completes payments with real-format signatures', async () => {
    const fake = createFakePaymentProvider('s3cret');
    expect(fake.keyId).toBeNull();
    const order = await fake.createOrder({ amountPaise: 100, receipt: 'r', notes: {} });
    expect(order.id).toMatch(/^order_fake_[a-f0-9]{16}$/);
    const { payment, signature } = fake.completePayment({
      orderId: order.id,
      amountPaise: 100,
      outcome: 'paid',
    });
    expect(payment).toMatchObject({ status: 'captured', amountPaise: 100, orderId: order.id });
    expect(fake.verifyCheckoutSignature(order.id, payment.id, signature)).toBe(true);
    expect(await fake.fetchPayment(payment.id)).toMatchObject({ status: 'captured' });
    expect((await fake.capturePayment(payment.id, 100)).status).toBe('captured');
    const failed = fake.completePayment({ orderId: order.id, amountPaise: 100, outcome: 'failed' });
    expect(failed.payment).toMatchObject({
      status: 'failed',
      errorDescription: 'Test payment declined',
    });
    await expect(fake.fetchPayment('nope')).rejects.toThrow(/Unknown/);
    await expect(fake.capturePayment('nope', 1)).rejects.toThrow(/Unknown/);
    const body = Buffer.from('{}');
    expect(fake.verifyWebhookSignature(body, fake.signWebhook(body))).toBe(true);
  });

  it('is chosen by PAYMENT_PROVIDER', () => {
    const base = { RAZORPAY_KEY_ID: 'k', RAZORPAY_KEY_SECRET: 's', RAZORPAY_WEBHOOK_SECRET: 'w' };
    expect(
      createPaymentProvider({ ...base, PAYMENT_PROVIDER: 'fake', FAKE_PAYMENT_SECRET: undefined })
        .name,
    ).toBe('fake');
    const real = createPaymentProvider(
      { ...base, PAYMENT_PROVIDER: 'razorpay', FAKE_PAYMENT_SECRET: undefined },
      { baseUrl },
    );
    expect(real.name).toBe('razorpay');
    expect(real.keyId).toBe('k');
    expect(
      createPaymentProvider({
        PAYMENT_PROVIDER: 'razorpay',
        FAKE_PAYMENT_SECRET: undefined,
        RAZORPAY_KEY_ID: undefined,
        RAZORPAY_KEY_SECRET: undefined,
        RAZORPAY_WEBHOOK_SECRET: undefined,
      }).keyId,
    ).toBe('');
  });
});
