import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadEnv } from '../../src/config/env';
import { MockPaymentRecordModel } from '../../src/db/models/mock-payment-record.model';
import { normalizeMockPhone } from '../../src/modules/mock-apis/mock.service';
import { useTestDb } from '../helpers/db';
import { PRODUCTION_APP_ENV } from '../helpers/production-env';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const app = buildTestApp();
const URL = '/api/v1/mock/payment-status';

afterEach(() => vi.useRealTimers());

describe('mock payment API (dev only)', () => {
  it('answers by the last digit when nothing is seeded (no auth needed)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-08T19:00:00Z')); // 9 Oct, 00:30 IST
    const even = await request(app).get(URL).query({ phone: '+919000000002' });
    expect(even.status).toBe(200);
    expect(even.body).toEqual({
      found: false,
      status: 'paid',
      amountRupees: 2500,
      paidOn: '2026-10-08',
      loanId: null,
    });
    const odd = await request(app).get(`${URL}?phone=%2B919000000001&loanId=L-9`);
    expect(odd.body).toEqual({
      found: false,
      status: 'unpaid',
      amountRupees: 2500,
      paidOn: null,
      loanId: 'L-9',
    });
  });

  it('seeded records win (optionally per loan)', async () => {
    await MockPaymentRecordModel.create([
      {
        phoneE164: '+919000000004',
        status: 'partial',
        amountMicros: 1_250_500_000,
        paidOn: '2026-10-01',
      },
      { phoneE164: '+919000000004', loanId: 'L-2', status: 'unpaid', amountMicros: 9_000_000_000 },
    ]);
    const loan = await request(app).get(URL).query({ phone: '+919000000004', loanId: 'L-2' });
    expect(loan.body).toEqual({
      found: true,
      status: 'unpaid',
      amountRupees: 9000,
      paidOn: null,
      loanId: 'L-2',
    });
    const partial = await request(app).get(`${URL}?phone=%2B919000000004&loanId=`);
    expect(partial.status).toBe(422);
    const noLoan = await request(app).get(`${URL}?phone=%2B919000000004`);
    expect(noLoan.body.found).toBe(true);
  });

  it('accepts a "+" that arrived as a space, rejects bad phones', async () => {
    // an unencoded "+" in a query string is decoded as a space
    const res = await request(app).get(`${URL}?phone=+919000000006`);
    expect(res.body.status).toBe('paid');
    expect(normalizeMockPhone('919000000006')).toBe('+919000000006');
    for (const phone of ['abc', '123', '+0123456789']) {
      expect((await request(app).get(URL).query({ phone })).status).toBe(422);
    }
    expect((await request(app).get(URL)).status).toBe(422);
  });

  it('is not mounted when disabled or in production', async () => {
    const off = buildTestApp({ MOCK_APIS_ENABLED: 'false' });
    expect((await request(off).get(URL).query({ phone: '+919000000002' })).status).toBe(404);
    const prod = buildTestApp(PRODUCTION_APP_ENV);
    expect((await request(prod).get(URL).query({ phone: '+919000000002' })).status).toBe(404);
    expect(() => loadEnv({ ...PRODUCTION_APP_ENV, MOCK_APIS_ENABLED: 'true' })).toThrow();
  });
});
