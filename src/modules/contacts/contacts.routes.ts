import { Router } from 'express';

import { accepted, created, noContent, ok } from '../../shared/http/envelope';
import { access } from '../../shared/middlewares/access';
import { authenticate } from '../../shared/middlewares/authenticate';
import { requirePermission } from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';

import { BulkBody } from './bulk.schema';
import { runBulk } from './bulk.service';
import {
  ContactIdParams,
  CreateContactBody,
  ListContactsQuery,
  SearchContactsBody,
  UpdateContactBody,
} from './contacts.schema';
import {
  createContact,
  deleteContact,
  getContact,
  listContacts,
  listTags,
  searchContacts,
  updateContact,
} from './contacts.service';
import { unavailableContactJobs, type ContactJobs } from './jobs';

/** `/api/v1/contacts` — contacts CRUD, search and filters. */
export const createContactsRouter = ({
  jobs = unavailableContactJobs,
}: { jobs?: ContactJobs } = {}): Router => {
  const router = Router();
  router.use(authenticate({ apiKeys: true }));
  // public API (ADR 0045): same routes, a key with the scope instead of the permission
  const apiRead = access({ permission: 'contacts.read', scope: 'contacts:read' });
  const apiWrite = access({ permission: 'contacts.write', scope: 'contacts:write' });

  router.get(
    '/',
    apiRead,
    ...handle({ query: ListContactsQuery }, async ({ query, req, res }) => {
      const page = await listContacts(req, query);
      ok(res, page.items, page.meta);
    }),
  );
  router.post(
    '/search',
    requirePermission('contacts.read'),
    ...handle({ body: SearchContactsBody }, async ({ body, req, res }) => {
      const page = await searchContacts(req, body);
      ok(res, page.items, page.meta);
    }),
  );
  router.post(
    '/bulk',
    requirePermission('contacts.write'),
    ...handle({ body: BulkBody }, async ({ body, req, res }) => {
      const result = await runBulk(req, body, jobs);
      if (result.jobQueued) accepted(res, result);
      else ok(res, result);
    }),
  );
  router.post(
    '/',
    apiWrite,
    ...handle({ body: CreateContactBody }, async ({ body, req, res }) => {
      created(res, await createContact(req, body));
    }),
  );
  router.get(
    '/:id',
    apiRead,
    ...handle({ params: ContactIdParams }, async ({ params, req, res }) => {
      ok(res, await getContact(req, params.id));
    }),
  );
  router.patch(
    '/:id',
    apiWrite,
    ...handle(
      { params: ContactIdParams, body: UpdateContactBody },
      async ({ params, body, req, res }) => {
        ok(res, await updateContact(req, params.id, body));
      },
    ),
  );
  router.delete(
    '/:id',
    requirePermission('contacts.write'),
    ...handle({ params: ContactIdParams }, async ({ params, req, res }) => {
      await deleteContact(req, params.id);
      noContent(res);
    }),
  );
  return router;
};

/** `/api/v1/contact-tags` — tags in use. */
export const createContactTagsRouter = (): Router => {
  const router = Router();
  router.get('/', authenticate(), requirePermission('contacts.read'), async (req, res) => {
    ok(res, await listTags(req));
  });
  return router;
};
