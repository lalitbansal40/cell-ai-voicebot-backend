import { Router } from 'express';

import { accepted, created, ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import { requirePermission } from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';
import { unavailableContactJobs, type ContactJobs } from '../contacts/jobs';

import {
  CreateListBody,
  ListIdParams,
  ListListsQuery,
  UpdateListBody,
} from './contact-lists.schema';
import { createList, deleteList, getList, listLists, updateList } from './contact-lists.service';

/** `/api/v1/contact-lists`. */
export const createContactListsRouter = ({
  jobs = unavailableContactJobs,
}: { jobs?: ContactJobs } = {}): Router => {
  const router = Router();
  router.use(authenticate());
  router.get(
    '/',
    requirePermission('contacts.read'),
    ...handle({ query: ListListsQuery }, async ({ query, req, res }) => {
      const page = await listLists(req, query);
      ok(res, page.items, page.meta);
    }),
  );
  router.post(
    '/',
    requirePermission('contacts.write'),
    ...handle({ body: CreateListBody }, async ({ body, req, res }) => {
      created(res, await createList(req, body));
    }),
  );
  router.get(
    '/:id',
    requirePermission('contacts.read'),
    ...handle({ params: ListIdParams }, async ({ params, req, res }) => {
      ok(res, await getList(req, params.id));
    }),
  );
  router.patch(
    '/:id',
    requirePermission('contacts.write'),
    ...handle(
      { params: ListIdParams, body: UpdateListBody },
      async ({ params, body, req, res }) => {
        ok(res, await updateList(req, params.id, body));
      },
    ),
  );
  router.delete(
    '/:id',
    requirePermission('contacts.write'),
    ...handle({ params: ListIdParams }, async ({ params, req, res }) => {
      await deleteList(req, params.id, jobs);
      accepted(res, { jobQueued: true as const });
    }),
  );
  return router;
};
