import type { Server } from 'node:http';

/**
 * Starts listening. Without a host Node binds every interface on both IPv4 and IPv6
 * (`localhost` may resolve to `::1`); `HOST` (e.g. 127.0.0.1 behind nginx) narrows it.
 */
export const listen = (server: Server, port: number, host?: string): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    const done = () => {
      server.off('error', reject);
      resolve();
    };
    if (host) server.listen(port, host, done);
    else server.listen(port, done);
  });
