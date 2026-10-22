import type { MessageStatus } from '../../db/models/message.model';

/** Outgoing status order (PHASE_10_PLAN §1e) — a lower status never replaces a higher one. */
export const STATUS_RANK: Partial<Record<MessageStatus, number>> = {
  queued: 0,
  accepted: 1,
  sent: 2,
  delivered: 3,
  read: 4,
};

/** Meta status names → ours (`played` = a voice note was listened to → read). */
export const fromMetaStatus = (value: string): MessageStatus | null => {
  switch (value.toLowerCase()) {
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'read':
    case 'played':
      return 'read';
    case 'failed':
      return 'failed';
    case 'deleted':
      return 'deleted';
    default:
      return null;
  }
};

/**
 * May `next` replace `current`? Statuses arrive out of order and twice:
 * forward moves only; `failed` overrides anything below `delivered` (a later
 * failure after delivery is ignored); nothing moves a `failed` message except a
 * later `delivered` / `read` (Meta retried and got through); `deleted` applies to
 * inbound messages only.
 */
export const canMoveTo = (
  current: MessageStatus,
  next: MessageStatus,
  direction: 'in' | 'out',
): boolean => {
  if (current === next) return false;
  if (direction === 'in') return next === 'deleted' && current === 'received';
  if (next === 'deleted' || next === 'received') return false;
  const from = STATUS_RANK[current];
  if (next === 'failed') return from !== undefined && from < (STATUS_RANK.delivered ?? 3);
  const to = STATUS_RANK[next];
  if (to === undefined) return false;
  if (current === 'failed') return to >= (STATUS_RANK.delivered ?? 3);
  return from !== undefined && to > from;
};
