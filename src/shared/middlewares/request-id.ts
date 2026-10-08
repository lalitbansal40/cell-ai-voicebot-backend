import { randomUUID } from 'node:crypto';

import type { RequestHandler } from 'express';

export const REQUEST_ID_HEADER = 'X-Request-Id';
const VALID_REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/** Accepts a safe incoming X-Request-Id or generates one; always echoes it back. */
export const requestId = (): RequestHandler => (req, res, next) => {
  const incoming = req.get(REQUEST_ID_HEADER);
  req.id = incoming && VALID_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, req.id);
  next();
};
