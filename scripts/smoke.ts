/**
 * Smoke checks of a deployed stack (Phase 13). Prints one line per check, never a secret,
 * and exits 1 on the first failure (deploy.sh then rolls back).
 *
 *   npm run smoke -- --url https://<app-host> [--expect-commit <sha>]
 *        [--demo-email <e-mail> --demo-password-env <ENV NAME>]
 *   npm run smoke -- --url http://127.0.0.1:5100 --internal   (on the server: API only)
 *
 * The demo password and the Meta verify token are read from the environment (the named
 * variable / META_WEBHOOK_VERIFY_TOKEN), never from the command line.
 */
import { randomBytes } from 'node:crypto';

import { runOp, say } from '../src/ops/cli';

export interface SmokeOptions {
  url: string;
  internal: boolean;
  expectCommit?: string | undefined;
  demoEmail?: string | undefined;
  demoPassword?: string | undefined;
  verifyToken?: string | undefined;
  /** WebSocket open timeout. */
  wsTimeoutMs?: number;
}

export interface SmokeResult {
  name: string;
  ok: boolean;
  detail?: string;
}

type Fetch = typeof fetch;

class CheckFailed extends Error {}

const need = (cond: unknown, detail: string): void => {
  if (!cond) throw new CheckFailed(detail);
};

const json = async (res: Response): Promise<Record<string, unknown>> => {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const data = (body: Record<string, unknown>) => (body.data ?? {}) as Record<string, unknown>;

/** Opens `wss://…/ws/events?ticket=…` and resolves when it is open (or rejects). */
const openSocket = (url: string, timeoutMs: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new CheckFailed(`no open within ${String(timeoutMs)} ms`));
    }, timeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      ws.close();
      resolve();
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new CheckFailed('socket error'));
    });
  });

/** Runs every check in order; stops at the first failure. */
export const runSmoke = async (
  opts: SmokeOptions,
  {
    fetchImpl = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }),
    open = openSocket,
  }: { fetchImpl?: Fetch; open?: typeof openSocket } = {},
): Promise<SmokeResult[]> => {
  const base = opts.url.replace(/\/+$/, '');
  const https = base.startsWith('https://');
  const results: SmokeResult[] = [];
  let token = '';
  const checks: [string, () => Promise<void>][] = [
    [
      'health',
      async () => {
        const res = await fetchImpl(`${base}/api/v1/health`);
        need(res.status === 200, `status ${String(res.status)}`);
        const d = data(await json(res));
        need(d.status === 'ok', 'status not ok');
        if (opts.expectCommit)
          need(
            d.commit === opts.expectCommit,
            `commit ${String(d.commit)}, expected ${opts.expectCommit}`,
          );
        if (https)
          need(res.headers.get('strict-transport-security'), 'no Strict-Transport-Security header');
      },
    ],
    [
      opts.internal ? 'ready' : 'ready is not public',
      async () => {
        if (opts.internal) {
          const res = await fetchImpl(`${base}/api/v1/ready`);
          need(res.status === 200, `status ${String(res.status)}`);
          return;
        }
        // readiness names the dependencies that are down: only the server may read it
        for (const path of ['/ready', '/api/v1/ready']) {
          const res = await fetchImpl(`${base}${path}`);
          need(res.status === 404, `public ${path} answered ${String(res.status)}`);
        }
      },
    ],
  ];
  if (!opts.internal) {
    checks.push(
      [
        'app shell + cache headers',
        async () => {
          const res = await fetchImpl(`${base}/`);
          need(res.status === 200, `status ${String(res.status)}`);
          const html = await res.text();
          need(html.includes('<div id="root">'), 'no root element');
          need(
            (res.headers.get('cache-control') ?? '').includes('no-cache'),
            'index.html is cached',
          );
          const asset = /\/assets\/[\w.-]+\.js/.exec(html)?.[0];
          need(asset, 'no script asset in index.html');
          const a = await fetchImpl(`${base}${asset ?? ''}`);
          need(a.status === 200, `asset status ${String(a.status)}`);
          need((a.headers.get('cache-control') ?? '').includes('immutable'), 'asset not immutable');
        },
      ],
      [
        'robots + legal pages',
        async () => {
          const robots = await fetchImpl(`${base}/robots.txt`);
          need((await robots.text()).includes('Disallow: /'), 'robots.txt allows indexing');
          for (const page of ['/privacy', '/terms', '/contact', '/data-deletion']) {
            const res = await fetchImpl(`${base}${page}`);
            need(res.status === 200, `${page} status ${String(res.status)}`);
          }
        },
      ],
    );
  }
  if (opts.demoEmail && opts.demoPassword) {
    checks.push(
      [
        'demo sign-in',
        async () => {
          const res = await fetchImpl(`${base}/api/v1/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: opts.demoEmail, password: opts.demoPassword }),
          });
          need(res.status === 200, `status ${String(res.status)}`);
          const access = data(await json(res)).accessToken;
          token = typeof access === 'string' ? access : '';
          need(token, 'no access token');
        },
      ],
      [
        'websocket',
        async () => {
          const res = await fetchImpl(`${base}/api/v1/ws/tickets`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ channel: 'events' }),
          });
          need(res.status === 201, `ticket status ${String(res.status)}`);
          const raw = data(await json(res)).ticket;
          const ticket = typeof raw === 'string' ? raw : '';
          need(ticket, 'no ticket');
          const ws = `${base.replace(/^http/, 'ws')}/ws/events?ticket=${encodeURIComponent(ticket)}`;
          await open(ws, opts.wsTimeoutMs ?? 5_000);
        },
      ],
    );
  }
  if (opts.verifyToken) {
    checks.push([
      'meta webhook verify',
      async () => {
        const challenge = randomBytes(8).toString('hex');
        const q = new URLSearchParams({
          'hub.mode': 'subscribe',
          'hub.verify_token': opts.verifyToken ?? '',
          'hub.challenge': challenge,
        });
        const res = await fetchImpl(`${base}/api/v1/webhooks/meta?${q.toString()}`);
        need(res.status === 200, `status ${String(res.status)}`);
        need((await res.text()) === challenge, 'challenge not echoed');
      },
    ]);
  }
  for (const [name, check] of checks) {
    try {
      await check();
      results.push({ name, ok: true });
    } catch (err) {
      results.push({
        name,
        ok: false,
        detail: err instanceof CheckFailed ? err.message : 'request failed',
      });
      break;
    }
  }
  return results;
};

/** `--name value` pairs and `--flag`s. */
export const parseSmokeArgs = (args: string[], env: NodeJS.ProcessEnv): SmokeOptions => {
  const value = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const url = value('url');
  if (!url || !/^https?:\/\/[^\s/]+/.test(url))
    throw new Error('Usage: npm run smoke -- --url <https://host>');
  const passwordEnv = value('demo-password-env');
  if (value('demo-email') && (!passwordEnv || !env[passwordEnv]))
    throw new Error('Demo sign-in requires a populated --demo-password-env variable');
  if (passwordEnv && !value('demo-email')) throw new Error('--demo-email is required');
  return {
    url,
    internal: args.includes('--internal'),
    expectCommit: value('expect-commit'),
    demoEmail: value('demo-email'),
    demoPassword: passwordEnv ? env[passwordEnv] : undefined,
    verifyToken: env.META_WEBHOOK_VERIFY_TOKEN || undefined,
  };
};

const main = async (args: string[]): Promise<void> => {
  const results = await runSmoke(parseSmokeArgs(args, process.env));
  for (const r of results) say(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? `: ${r.detail}` : ''}`);
  if (results.some((r) => !r.ok)) throw new Error('smoke failed');
  say(`smoke ok (${String(results.length)} checks)`);
};

if (require.main === module) runOp(main);
