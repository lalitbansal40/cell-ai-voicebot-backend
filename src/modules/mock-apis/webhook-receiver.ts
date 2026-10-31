import type { Env } from '../../config/env';
import { WEBHOOK_LIMITS } from '../../config/limits';
import { WebhookEndpointModel } from '../../db/models/webhook-endpoint.model';
import { open, secretBoxKey } from '../../shared/crypto/secret-box';
import { verify } from '../webhooks/signing';

export const DEV_RECEIVER_PATH = '/api/v1/mock/webhook-receiver';
export const DEV_RECEIVER_KEEP = 50;

export interface Receipt {
  at: string;
  eventId: string | null;
  type: string | null;
  verified: boolean;
  bytes: number;
}

/** DEV ONLY: the receiver's memory (ids, types and the check — never payloads). */
const receipts: Receipt[] = [];

export const listReceipts = (): Receipt[] => [...receipts];
export const clearReceipts = (): void => {
  receipts.length = 0;
};

/** The address webhook endpoints use to reach this API's own dev receiver. */
export const devReceiverUrl = (env: Pick<Env, 'PORT'>): string =>
  `http://127.0.0.1:${String(env.PORT)}${DEV_RECEIVER_PATH}`;

const typeOf = (raw: Buffer): string | null => {
  try {
    const body = JSON.parse(raw.toString('utf8')) as { type?: unknown };
    return typeof body.type === 'string' ? body.type.slice(0, 60) : null;
  } catch {
    return null;
  }
};

/**
 * Checks the delivery against the secrets of every endpoint pointing at this
 * receiver (any account — dev only), keeps the last 50 receipts.
 */
export const receiveWebhook = async (
  env: Pick<Env, 'ENCRYPTION_KEY' | 'NODE_ENV'>,
  raw: Buffer,
  headers: { signature?: string; timestamp?: string; id?: string },
): Promise<Receipt> => {
  const endpoints = await WebhookEndpointModel.find({
    url: { $regex: `${DEV_RECEIVER_PATH.replace(/\//g, '\\/')}$` },
  })
    .select('+secretSealed +secretPreviousSealed')
    .lean();
  const key = secretBoxKey(env);
  const overlapMs = WEBHOOK_LIMITS.secretRotationOverlapHours * 3_600_000;
  // current secret, plus the previous one during a rotation (as deliveries sign)
  const secrets = endpoints.flatMap((e) => [
    open(key, e.secretSealed),
    ...(e.secretPreviousSealed && e.rotatedAt && Date.now() - e.rotatedAt.getTime() < overlapMs
      ? [open(key, e.secretPreviousSealed)]
      : []),
  ]);
  const receipt: Receipt = {
    at: new Date().toISOString(),
    eventId: headers.id?.slice(0, 60) ?? null,
    type: typeOf(raw),
    verified: verify(headers.signature, secrets, headers.timestamp, raw),
    bytes: raw.length,
  };
  receipts.unshift(receipt);
  receipts.length = Math.min(receipts.length, DEV_RECEIVER_KEEP);
  return receipt;
};
