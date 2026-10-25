import { Socket } from 'node:dgram';

import { expect, vi } from 'vitest';

/** Run after media teardown: a closed peer must leave no UDP sockets in this worker. */
export const expectNoUdpHandles = async (): Promise<void> => {
  const handles = process as unknown as { _getActiveHandles(): unknown[] };
  await vi.waitFor(
    () => {
      expect(handles._getActiveHandles().filter((handle) => handle instanceof Socket)).toHaveLength(
        0,
      );
    },
    { timeout: 3_000, interval: 20 },
  );
};
