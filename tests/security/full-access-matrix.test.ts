import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createCallingRuntime } from '../../src/modules/whatsapp-calling/runtime';
import { createTestAccount, TEST_PASSWORD, tokenFor } from '../helpers/auth';
import { ensureRateCard } from '../helpers/calls';
import { recordingContactJobs } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { useInboxWorld } from '../helpers/inbox';
import { buildTestApp } from '../helpers/test-app';

/**
 * SAC-T2: a superadmin "Full access" session reaches every dashboard route the owner can —
 * never `AUTH_IMPERSONATION_BLOCKED`. Danger actions answer `STEP_UP_REQUIRED` until a step-up,
 * Add money answers `WALLET_TOPUP_IMPERSONATION`. Routes come from the generated OpenAPI file.
 */
useTestDb();
const world = useInboxWorld();
const { state } = world;

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
const spec = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../openapi/openapi.json'), 'utf8'),
) as { paths: Record<string, Partial<Record<Method, unknown>>> };

/** Public / platform / provider routes — not owner dashboard routes. */
const NOT_DASHBOARD = [
  /^\/api\/v1\/admin\//,
  /^\/api\/v1\/webhooks\//,
  /^\/api\/v1\/meta\//,
  /^\/api\/v1\/mock\//,
  /^\/api\/v1\/dev\//,
  /^\/api\/v1\/report-unsubscribe/,
  /^\/api\/v1\/csp-report/,
  /^\/api\/v1\/(openapi|openapi\.public|postman)\.json$/,
  /^\/api\/v1\/auth\/(signup|login|refresh|logout$|forgot-password|reset-password|verify-email|invites)/,
  /^\/api\/v1\/team\/invites\/accept/,
  /^\/api\/v1\/auth\/login-as\//,
  /^\/api\/v1\/(health|ready)$/,
];

/** Danger actions (D2): a step-up first. */
const STEP_UP: string[] = [
  'post /api/v1/account/export',
  'get /api/v1/account/exports/{id}',
  'post /api/v1/account/delete',
  'post /api/v1/account/delete/cancel',
  'post /api/v1/team/transfer-ownership',
  'post /api/v1/auth/change-password',
  'post /api/v1/auth/logout-all',
  'delete /api/v1/auth/sessions/{id}',
  'post /api/v1/api-keys',
  'patch /api/v1/api-keys/{id}',
  'post /api/v1/contacts/bulk-erase',
  'post /api/v1/contacts/{id}/erase',
];

const routes = Object.entries(spec.paths).flatMap(([p, ops]) =>
  (Object.keys(ops) as Method[])
    .filter((m) => ['get', 'post', 'put', 'patch', 'delete'].includes(m))
    .filter(() => !NOT_DASHBOARD.some((re) => re.test(p)))
    .map((m) => [m, p] as const),
);
const filled = (p: string) => p.replace(/\{[^}]+\}/g, () => new Types.ObjectId().toString());

let app: ReturnType<typeof buildTestApp>;
let full: string;
let view: string;

beforeAll(async () => {
  await ensureRateCard();
  const runtime = createCallingRuntime({ ctx: world.w.ctx, service: world.w.svc, inbox: state.ix });
  state.h.calling = runtime.hooks;
  const { users } = await world.setup();
  app = buildTestApp(
    {},
    {
      storage: world.storage,
      contactJobs: recordingContactJobs().jobs,
      authRateLimit: { limit: 100_000 },
      rateLimit: { limit: 100_000 },
      whatsapp: {
        ctx: world.w.ctx,
        jobs: { enqueueEvent: () => Promise.resolve() },
        inboxJobs: world.jobs,
        storage: world.storage,
        calling: runtime,
      },
    },
  );
  const platform = await createTestAccount({ isPlatform: true });
  const sa = await platform.addUser('owner', { platformRole: 'superadmin' });
  const claims = (imm: 'full' | 'view') => ({
    sid: `imp_matrix_${imm}_${Date.now().toString(36)}`,
    imp: sa.user._id.toString(),
    imm,
    imk: 'superadmin' as const,
    ims: Math.floor(Date.now() / 1000),
  });
  full = await tokenFor(users.owner.user, claims('full'));
  view = await tokenFor(users.owner.user, claims('view'));
});

const call = (method: Method, p: string, token: string) =>
  request(app)[method](filled(p)).set('Authorization', `Bearer ${token}`).send({});

describe('superadmin full access route matrix (SAC-T2)', () => {
  it('covers the dashboard routes of the contract', () => {
    expect(routes.length).toBeGreaterThan(300);
  });

  it('full access is never refused as a login-as; danger actions ask for a step-up', async () => {
    const blocked: string[] = [];
    const stepUp: string[] = [];
    for (const [method, p] of routes) {
      const res = await call(method, p, full);
      const code = (res.body as { error?: { code?: string } }).error?.code;
      if (code === 'AUTH_IMPERSONATION_BLOCKED') blocked.push(`${method} ${p}`);
      if (code === 'STEP_UP_REQUIRED') stepUp.push(`${method} ${p}`);
    }
    expect(blocked).toEqual([]);
    expect(stepUp.sort()).toEqual([...STEP_UP].sort());
  }, 240_000);

  it('a view session is still read-only and Add money stays refused in full access', async () => {
    const write = await call('post', '/api/v1/team/invites', view);
    expect(write.body.error.code).toBe('AUTH_IMPERSONATION_BLOCKED');
    const topup = await request(app)
      .post('/api/v1/wallet/topups')
      .set('Authorization', `Bearer ${full}`)
      .set('Idempotency-Key', 'sac-topup-1')
      .send({ amountRupees: 500 });
    expect(topup.status).toBe(403);
    expect(topup.body.error.code).toBe('WALLET_TOPUP_IMPERSONATION');
  });

  it('after a step-up the danger action runs (the owner password is not needed)', async () => {
    const before = await request(app)
      .post('/api/v1/account/export')
      .set('Authorization', `Bearer ${full}`)
      .send({});
    expect(before.body.error.code).toBe('STEP_UP_REQUIRED');
    const step = await request(app)
      .post('/api/v1/auth/login-as/step-up')
      .set('Authorization', `Bearer ${full}`)
      .send({ password: TEST_PASSWORD });
    expect(step.status).toBe(200);
    const after = await request(app)
      .post('/api/v1/account/export')
      .set('Authorization', `Bearer ${full}`)
      .send({});
    expect(after.status).toBe(202);
  });
});
