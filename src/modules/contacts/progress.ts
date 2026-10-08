import { CONTACT_LIMITS } from '../../config/limits';
import { notifyAccount } from '../../core/realtime/notify';

/**
 * Throttled progress events (≤ 1 / s) — always sent when the status changes
 * or when `force` is set (websocket.md §5).
 */
export const createProgressReporter = (
  accountId: string,
  type: 'import.progress' | 'export.progress',
  id: { importJobId: string } | { exportJobId: string },
  throttleMs: number = CONTACT_LIMITS.progressThrottleMs,
) => {
  let lastAt = 0;
  let lastStatus = '';
  return (processed: number, total: number, status: string, force = false): void => {
    const now = Date.now();
    if (!force && status === lastStatus && now - lastAt < throttleMs) return;
    lastAt = now;
    lastStatus = status;
    notifyAccount(accountId, type, { ...id, processed, total, status });
  };
};
