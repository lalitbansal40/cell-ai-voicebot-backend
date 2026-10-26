import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { loadEnv } from '../../src/config/env';
import { listen } from '../../src/shared/http/listen';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

const start = async (host: string | undefined) => {
  const server = createServer((_req, res) => res.end('ok'));
  servers.push(server);
  await listen(server, 0, host);
  return (server.address() as AddressInfo).port;
};
const reach = (url: string) =>
  fetch(url).then(
    (r) => r.status,
    () => 'refused' as const,
  );

describe('listen (HOST env)', () => {
  it('by default answers on IPv4 and IPv6 loopback (localhost may be ::1)', async () => {
    const port = await start(loadEnv({}).HOST);
    expect(await reach(`http://127.0.0.1:${String(port)}/`)).toBe(200);
    expect(await reach(`http://[::1]:${String(port)}/`)).toBe(200);
  });

  it('HOST=127.0.0.1 keeps it on the IPv4 loopback only', async () => {
    const port = await start(loadEnv({ HOST: '127.0.0.1' }).HOST);
    expect(await reach(`http://127.0.0.1:${String(port)}/`)).toBe(200);
    expect(await reach(`http://[::1]:${String(port)}/`)).toBe('refused');
  });
});
