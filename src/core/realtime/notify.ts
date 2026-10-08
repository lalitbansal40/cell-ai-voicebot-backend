import { getLogger } from '../../shared/logger';

import { tryGetRealtime } from './index';

/**
 * Fire-and-forget realtime notifications for services. No-op when the
 * realtime server isn't running (tests, scripts); failures are logged —
 * a lost WS event must never fail the request (clients refetch on reconnect).
 */
export const notifyAccount = (accountId: string, type: string, data: unknown = {}): void => {
  const rt = tryGetRealtime();
  if (!rt) return;
  void rt.pushToAccount(accountId, type, data).catch((err: unknown) => {
    getLogger().warn({ err, type }, 'realtime: notify failed');
  });
};

export const notifyUser = (
  accountId: string,
  userId: string,
  type: string,
  data: unknown = {},
  options: { close?: boolean } = {},
): void => {
  const rt = tryGetRealtime();
  if (!rt) return;
  void rt.pushToUser(accountId, userId, type, data, options).catch((err: unknown) => {
    getLogger().warn({ err, type }, 'realtime: notify failed');
  });
};
