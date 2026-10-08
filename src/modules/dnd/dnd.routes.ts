import { Router } from 'express';

import { created, noContent, ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import { requirePermission } from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema } from '../../shared/validation/schemas';

import { AddDndBody, DndIdParams, ListDndQuery } from './dnd.schema';
import { addDnd, listDnd, optOut, removeDnd, undoOptOut } from './dnd.service';

/** `/api/v1/dnd-entries` — the account's do-not-call list. */
export const createDndRouter = (): Router => {
  const router = Router();
  router.use(authenticate());
  router.get(
    '/',
    requirePermission('contacts.read'),
    ...handle({ query: ListDndQuery }, async ({ query, req, res }) => {
      const page = await listDnd(req, query);
      ok(res, page.items, page.meta);
    }),
  );
  router.post(
    '/',
    requirePermission('contacts.write'),
    ...handle({ body: AddDndBody }, async ({ body, req, res }) => {
      const result = await addDnd(req, body);
      if (result.created) created(res, result.entry);
      else ok(res, result.entry);
    }),
  );
  router.delete(
    '/:id',
    requirePermission('dnd.manage'),
    ...handle({ params: DndIdParams }, async ({ params, req, res }) => {
      await removeDnd(req, params.id);
      noContent(res);
    }),
  );
  return router;
};

const ContactParams = z.strictObject({ id: ObjectIdSchema });

/** `POST / DELETE /api/v1/contacts/:id/opt-out` (mounted under `/contacts`). */
export const createOptOutRouter = (): Router => {
  const router = Router();
  router.post(
    '/:id/opt-out',
    authenticate(),
    requirePermission('contacts.write'),
    ...handle({ params: ContactParams }, async ({ params, req, res }) => {
      ok(res, await optOut(req, params.id));
    }),
  );
  router.delete(
    '/:id/opt-out',
    authenticate(),
    requirePermission('dnd.manage'),
    ...handle({ params: ContactParams }, async ({ params, req, res }) => {
      ok(res, await undoOptOut(req, params.id));
    }),
  );
  return router;
};
