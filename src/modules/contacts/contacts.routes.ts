import { Router } from 'express';

import { created, noContent, ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import { requirePermission } from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';

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

/** `/api/v1/contacts` — contacts CRUD, search and filters. */
export const createContactsRouter = (): Router => {
  const router = Router();
  router.use(authenticate());

  router.get(
    '/',
    requirePermission('contacts.read'),
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
    '/',
    requirePermission('contacts.write'),
    ...handle({ body: CreateContactBody }, async ({ body, req, res }) => {
      created(res, await createContact(req, body));
    }),
  );
  router.get(
    '/:id',
    requirePermission('contacts.read'),
    ...handle({ params: ContactIdParams }, async ({ params, req, res }) => {
      ok(res, await getContact(req, params.id));
    }),
  );
  router.patch(
    '/:id',
    requirePermission('contacts.write'),
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
