import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import type { RequestHandler } from 'express';

import { safeDownloadName, type LocalStorage } from '../../core/storage';
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

/**
 * One `bytes=` range (audio players seek with them). Anything else → the whole
 * file; a range past the end → `unsatisfiable` (416).
 */
export const byteRange = (
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null => {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!m || (!m[1] && !m[2])) return null;
  let start: number;
  let end: number;
  if (!m[1]) {
    // suffix: the last N bytes
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start >= size || end < start) return 'unsatisfiable';
  return { start, end };
};

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

    const size = await storage.size(key); // NotFoundError → 404
    const remaining = Math.max(0, exp - Math.floor(Date.now() / 1000));
    res.setHeader('Content-Type', contentTypeFor(key));
    const name = safeDownloadName(typeof req.query.name === 'string' ? req.query.name : undefined);
    if (name) res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', `private, max-age=${remaining}`);
    // the signature is the permission: pages on the app origin may play / show it
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Accept-Ranges', 'bytes');
    const range = byteRange(req.headers.range, size);
    if (range === 'unsatisfiable') {
      res.status(416).setHeader('Content-Range', `bytes */${String(size)}`);
      res.end();
      return;
    }
    if (range) {
      res.status(206);
      res.setHeader(
        'Content-Range',
        `bytes ${String(range.start)}-${String(range.end)}/${String(size)}`,
      );
      res.setHeader('Content-Length', String(range.end - range.start + 1));
      await pipeline(await storage.get(key, range), res);
      return;
    }
    res.setHeader('Content-Length', String(size));
    await pipeline(await storage.get(key), res);
  };
