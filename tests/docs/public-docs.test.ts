import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { renderGuidesModule } from '../../scripts/generate-docs-guides';
import { GUIDE_ORDER, guidesMarkdown } from '../../src/modules/docs/guides';
import {
  buildPublicSpec,
  PUBLIC_API_TAG,
  type OpenApiDoc,
} from '../../src/modules/docs/public-spec';
import { buildOpenApiDocument } from '../../src/openapi';
import { buildTestApp } from '../helpers/test-app';

const root = path.resolve(__dirname, '..', '..');
const webhooksDoc = readFileSync(path.join(root, 'docs', 'api', 'webhooks.md'), 'utf8');
const vectors = (
  JSON.parse(
    readFileSync(path.join(root, 'tests', 'fixtures', 'webhooks', 'vectors.json'), 'utf8'),
  ) as { vectors: { secret: string; timestamp: number; body: string; signature: string }[] }
).vectors;
const codeBlock = (lang: string): string =>
  new RegExp(`\`\`\`${lang}\\n([\\s\\S]*?)\\n\`\`\``).exec(webhooksDoc)?.[1] ?? '';

const full = buildOpenApiDocument() as unknown as OpenApiDoc;
const operations = (doc: OpenApiDoc) =>
  Object.entries(doc.paths).flatMap(([p, item]) =>
    Object.entries(item).map(([m, op]) => ({
      key: `${m.toUpperCase()} ${p}`,
      tags: (op as { tags?: string[] }).tags ?? [],
      security: JSON.stringify((op as { security?: unknown }).security ?? []),
    })),
  );

describe('public API docs (plan §7 #6)', () => {
  const pub = buildPublicSpec(full);

  it('lists exactly the key-enabled routes, nothing dashboard-only', () => {
    const keyRoutes = operations(full)
      .filter((o) => o.security.includes('apiKeyAuth'))
      .map((o) => o.key)
      .sort();
    const listed = operations(pub)
      .map((o) => o.key)
      .sort();
    expect(listed).toEqual(keyRoutes);
    expect(listed.length).toBeGreaterThanOrEqual(48);
    for (const o of operations(pub)) expect(o.tags, o.key).toContain(PUBLIC_API_TAG);
    for (const hidden of ['/api/v1/auth/login', '/api/v1/admin/accounts', '/api/v1/wallet/topups'])
      expect(pub.paths[hidden], hidden).toBeUndefined();
    expect(pub.paths['/api/v1/api-keys/whoami']).toBeDefined();
  });

  it('keeps only the schemas the public routes reach, and the used tags', () => {
    const text = JSON.stringify(pub);
    for (const ref of text.match(/#\/components\/schemas\/[A-Za-z0-9_.-]+/g) ?? []) {
      expect(pub.components?.schemas?.[ref.split('/').pop() ?? ''], ref).toBeDefined();
    }
    expect(Object.keys(pub.components?.schemas ?? {}).length).toBeLessThan(
      Object.keys(full.components?.schemas ?? {}).length,
    );
    expect(pub.components?.schemas?.AdminAccount).toBeUndefined();
    const used = new Set(operations(pub).flatMap((o) => o.tags));
    for (const tag of pub.tags ?? []) expect(used.has(tag.name), tag.name).toBe(true);
  });

  it('carries the guides as its Markdown description', () => {
    const description = String(pub.info.description);
    expect(description).toBe(guidesMarkdown());
    for (const heading of [
      '## Getting started',
      '## Errors',
      '## Idempotency',
      '## Rate limits',
      '## Pagination',
      '## Webhooks',
      '## API changelog',
    ])
      expect(description).toContain(heading);
    expect(description).not.toMatch(/^# /m);
  });

  it('is served at /api/v1/openapi.public.json', async () => {
    const res = await request(buildTestApp()).get('/api/v1/openapi.public.json');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(Object.keys(res.body.paths)).toEqual(Object.keys(pub.paths));
  });

  it('guides.gen.ts matches docs/api/*.md (run `npm run gen:guides`)', async () => {
    const committed = readFileSync(
      path.join(root, 'src', 'modules', 'docs', 'guides.gen.ts'),
      'utf8',
    );
    expect(committed).toBe(await renderGuidesModule(root));
    expect(GUIDE_ORDER).toHaveLength(7);
  });
});

describe('docs/api/webhooks.md signature samples', () => {
  it('the Node sample accepts the golden vectors and refuses tampering / old timestamps', () => {
    const sandbox: { require: NodeRequire; Buffer: typeof Buffer; verify?: unknown } = {
      require,
      Buffer,
    };
    runInNewContext(`${codeBlock('js')}\nverify = verifyNotifyNow;`, sandbox);
    const verify = sandbox.verify as (
      raw: Buffer,
      headers: Record<string, string>,
      secret: string,
      toleranceSec?: number,
    ) => boolean;
    for (const v of vectors) {
      const headers = {
        'x-webhook-timestamp': String(v.timestamp),
        'x-webhook-signature': `v1=${'0'.repeat(64)}, v1=${v.signature}`,
      };
      const forever = 10 ** 10;
      expect(verify(Buffer.from(v.body), headers, v.secret, forever)).toBe(true);
      expect(verify(Buffer.from(`${v.body} `), headers, v.secret, forever)).toBe(false);
      expect(verify(Buffer.from(v.body), headers, `${v.secret}x`, forever)).toBe(false);
      expect(verify(Buffer.from(v.body), headers, v.secret)).toBe(false); // 2025 timestamp
    }
  });

  it('the Python sample agrees (skipped without python3)', () => {
    const probe = spawnSync('python3', ['--version']);
    if (probe.status !== 0) return; // no python3 on this machine — noted in the sign-off
    const v = vectors[0];
    if (!v) throw new Error('no vectors');
    const script = `${codeBlock('python')}
import json, sys
v = json.loads(sys.stdin.read())
h = {"X-Webhook-Timestamp": str(v["timestamp"]), "X-Webhook-Signature": "v1=" + v["signature"]}
ok = verify_notifynow(v["body"].encode(), h, v["secret"], tolerance_sec=10**10)
bad = verify_notifynow((v["body"] + " ").encode(), h, v["secret"], tolerance_sec=10**10)
old = verify_notifynow(v["body"].encode(), h, v["secret"])
print(json.dumps([ok, bad, old]))
`;
    const run = spawnSync('python3', ['-I', '-c', script], {
      input: JSON.stringify(v),
      encoding: 'utf8',
    });
    expect(run.stderr).toBe('');
    expect(JSON.parse(run.stdout)).toEqual([true, false, false]);
  });

  it('shows a PHP sample with a constant-time compare', () => {
    expect(codeBlock('php')).toContain('hash_equals');
    expect(codeBlock('php')).toContain("hash_hmac('sha256', $ts . '.' . $rawBody, $secret)");
  });
});
