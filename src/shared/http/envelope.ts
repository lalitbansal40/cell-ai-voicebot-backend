import type { Response } from 'express';

import type { ErrorDetail } from '../errors/app-error';
import type { ErrorCode } from '../errors/error-codes';

/** `{ success: true, data, meta? }` (docs/conventions/api.md §3). */
export interface SuccessEnvelope<T, M = Record<string, unknown>> {
  success: true;
  data: T;
  meta?: M;
}

/** `{ success: false, error }` — matches the OpenAPI `ErrorEnvelope` component. */
export interface ErrorEnvelope {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    details?: ErrorDetail[];
    requestId: string;
  };
}

export const ok = <T, M = Record<string, unknown>>(res: Response, data: T, meta?: M): Response =>
  res.status(200).json({
    success: true,
    data,
    ...(meta === undefined ? {} : { meta }),
  } satisfies SuccessEnvelope<T, M>);

export const created = <T>(res: Response, data: T): Response =>
  res.status(201).json({ success: true, data } satisfies SuccessEnvelope<T>);

export const noContent = (res: Response): Response => res.status(204).end();

/** 202 — work continues in the background (job queued). */
export const accepted = <T>(res: Response, data: T): Response =>
  res.status(202).json({ success: true, data } satisfies SuccessEnvelope<T>);
