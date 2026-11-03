import { json, Router, type Request, type Response } from 'express';

import { getLogger } from '../../shared/logger';
import { createRateLimiter } from '../../shared/middlewares/rate-limit';

/**
 * `POST /api/v1/csp-report` (Phase 17): browsers report what the Content-Security-Policy blocked,
 * while it is report-only. Public and rate-limited; logs only the directive and the blocked origin
 * (never the page path, which can hold ids). Always 204.
 */
const MAX_BYTES = 16 * 1024;
const TYPES = ['application/csp-report', 'application/reports+json', 'application/json'];

interface Violation {
  directive: string;
  blocked: string;
}

/** The origin only: `https://host` from a URL; keywords such as `inline` as they are. */
export const blockedOrigin = (value: unknown): string => {
  if (typeof value !== 'string' || !value) return 'unknown';
  try {
    return new URL(value).origin;
  } catch {
    return value.slice(0, 40).replace(/[^\w:-]/g, '');
  }
};

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const fromFields = (r: Record<string, unknown>): Violation => ({
  directive:
    (text(r['effective-directive']) || text(r.effectiveDirective) || text(r['violated-directive']))
      .split(' ')[0]
      ?.slice(0, 40) ?? '',
  blocked: blockedOrigin(r['blocked-uri'] ?? r.blockedURL),
});

/** Old browsers send `{ "csp-report": {…} }`, the Reporting API a list of `{ type, body }`. */
export const violationsOf = (body: unknown): Violation[] => {
  if (Array.isArray(body)) {
    return body
      .filter((r): r is { type: string; body: Record<string, unknown> } =>
        Boolean(r && typeof r === 'object' && (r as { type?: unknown }).type === 'csp-violation'),
      )
      .slice(0, 20)
      .map((r) => fromFields(r.body));
  }
  const report = (body as { 'csp-report'?: unknown } | null)?.['csp-report'];
  return report && typeof report === 'object'
    ? [fromFields(report as Record<string, unknown>)]
    : [];
};

export const createCspReportRouter = (): Router => {
  const router = Router();
  router.post(
    '/',
    createRateLimiter({ windowMs: 60_000, limit: 60 }),
    json({ type: TYPES, limit: MAX_BYTES }),
    (req: Request, res: Response) => {
      for (const v of violationsOf(req.body)) {
        getLogger().warn({ metric: 'csp_violation', ...v }, 'csp: blocked');
      }
      res.status(204).end();
    },
  );
  return router;
};
