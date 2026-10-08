import type { ErrorRequestHandler } from 'express';

import { AppError, isAppError } from '../errors/app-error';
import { ERROR_CODES } from '../errors/error-codes';
import type { ErrorEnvelope } from '../http/envelope';

import { getRequestId } from './request-id';

interface ParserError {
  type?: string;
  status?: number;
}

/** Maps body-parser / http-errors style errors onto catalogue codes. */
const fromParserError = (err: unknown): AppError | undefined => {
  if (typeof err !== 'object' || err === null) return undefined;
  const { type, status } = err as ParserError;
  if (type === 'entity.too.large' || status === 413) return new AppError('PAYLOAD_TOO_LARGE');
  if (type === 'entity.parse.failed') return new AppError('REQUEST_MALFORMED');
  if (type === 'encoding.unsupported' || status === 415)
    return new AppError('UNSUPPORTED_MEDIA_TYPE');
  if (typeof status === 'number' && status >= 400 && status < 500)
    return new AppError('REQUEST_MALFORMED');
  return undefined;
};

/** Final error middleware: every error becomes the standard error envelope. */
export const errorHandler = (): ErrorRequestHandler => (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  const appError = isAppError(err)
    ? err
    : (fromParserError(err) ??
      new AppError('INTERNAL_ERROR', undefined, undefined, { cause: err }));

  if (appError.status >= 500) {
    req.log.error({ err, code: appError.code }, 'request failed');
  } else {
    req.log.warn({ code: appError.code }, appError.message);
  }

  const body: ErrorEnvelope = {
    success: false,
    error: {
      code: appError.code,
      message: appError.expose ? appError.message : ERROR_CODES[appError.code].message,
      ...(appError.details?.length ? { details: appError.details } : {}),
      requestId: getRequestId(req),
    },
  };
  res.status(appError.status).json(body);
};
