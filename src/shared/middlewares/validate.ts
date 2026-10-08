import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType, z } from 'zod';

import { ValidationError, type ErrorDetail } from '../errors/app-error';
import { zodIssuesToDetails } from '../validation/zod-errors';

export interface RequestSchemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

type Parsed<S extends RequestSchemas, K extends keyof RequestSchemas> = S[K] extends ZodType
  ? z.infer<S[K]>
  : undefined;

export interface ValidatedRequest<S extends RequestSchemas> {
  body: Parsed<S, 'body'>;
  query: Parsed<S, 'query'>;
  params: Parsed<S, 'params'>;
}

const PARTS = ['body', 'query', 'params'] as const;

/**
 * Validates body / query / params with zod. Failure → 422 VALIDATION_FAILED with
 * `body.x` / `query.x` / `params.x` paths. Success → parsed values on `req.valid`
 * (Express 5 `req.query` is a read-only getter, so it is never reassigned).
 */
export const validate =
  (schemas: RequestSchemas): RequestHandler =>
  (req, _res, next) => {
    const details: ErrorDetail[] = [];
    const valid: Record<string, unknown> = {};
    for (const part of PARTS) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part] ?? {});
      if (result.success) valid[part] = result.data;
      else details.push(...zodIssuesToDetails(result.error.issues, part));
    }
    if (details.length) {
      next(new ValidationError(details));
      return;
    }
    req.valid = valid;
    next();
  };

/**
 * Typed route helper: validates, then calls `fn` with parsed, typed input.
 *
 *   router.post('/', ...handle({ body: CreateContactSchema }, async ({ body, res }) => created(res, await svc.create(body))));
 */
export const handle = <S extends RequestSchemas>(
  schemas: S,
  fn: (ctx: ValidatedRequest<S> & { req: Request; res: Response; next: NextFunction }) => unknown,
): RequestHandler[] => [
  validate(schemas),
  async (req, res, next) => {
    const valid = (req.valid ?? {}) as ValidatedRequest<S>;
    await fn({ body: valid.body, query: valid.query, params: valid.params, req, res, next });
  },
];
