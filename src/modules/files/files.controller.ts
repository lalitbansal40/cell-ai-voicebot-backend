import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import type { RequestHandler } from 'express';

import type { LocalStorage } from '../../core/storage';
import { ForbiddenError } from '../../shared/errors/app-error';

const CONTENT_TYPES: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.csv': 'text/csv',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

export const contentTypeFor = (key: string): string =>
  CONTENT_TYPES[path.extname(key).toLowerCase()] ?? 'application/octet-stream';

/** GET /files/*key?exp=&sig= — streams a local file behind a valid, unexpired signature. */
export const downloadFile =
  (storage: LocalStorage): RequestHandler =>
  async (req, res) => {
    const segments = (req.params as { key?: string[] | string }).key;
    const key = Array.isArray(segments) ? segments.join('/') : (segments ?? '');
    const exp = Number(req.query.exp);
    const sig = typeof req.query.sig === 'string' ? req.query.sig : '';
    const check = storage.verify(key, exp, sig);
    if (check !== 'ok')
      throw new ForbiddenError(check === 'expired' ? 'This link has expired.' : 'Invalid link.');

    const stream = await storage.get(key); // NotFoundError → 404
    const remaining = Math.max(0, exp - Math.floor(Date.now() / 1000));
    res.setHeader('Content-Type', contentTypeFor(key));
    res.setHeader('Cache-Control', `private, max-age=${remaining}`);
    await pipeline(stream, res);
  };
