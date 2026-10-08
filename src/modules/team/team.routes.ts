import { Router } from 'express';

import { created, noContent, ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import {
  blockWhenImpersonating,
  requirePermission,
} from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';

import {
  IdParams,
  InviteBody,
  ListMembersQuery,
  TransferOwnershipBody,
  UpdateMemberBody,
  UserIdParams,
} from './team.schema';
import {
  invite,
  listMembers,
  removeMember,
  resendInvite,
  revokeInvite,
  transferOwnership,
  updateMember,
} from './team.service';

/** `/api/v1/team` — members, invitations, ownership. */
export const createTeamRouter = (): Router => {
  const router = Router();
  router.use(authenticate());

  router.get(
    '/users',
    requirePermission('team.read'),
    ...handle({ query: ListMembersQuery }, async ({ query, req, res }) => {
      const { items, meta } = await listMembers(req, query);
      ok(res, items, meta);
    }),
  );
  router.post(
    '/invites',
    requirePermission('team.invite'),
    blockWhenImpersonating(),
    ...handle({ body: InviteBody }, async ({ body, req, res }) => {
      created(res, await invite(req, body));
    }),
  );
  router.post(
    '/invites/:userId/resend',
    requirePermission('team.invite'),
    blockWhenImpersonating(),
    ...handle({ params: UserIdParams }, async ({ params, req, res }) => {
      await resendInvite(req, params.userId);
      res.status(202).json({ success: true, data: { message: 'Invitation sent again.' } });
    }),
  );
  router.delete(
    '/invites/:userId',
    requirePermission('team.invite'),
    ...handle({ params: UserIdParams }, async ({ params, req, res }) => {
      await revokeInvite(req, params.userId);
      noContent(res);
    }),
  );
  router.patch(
    '/users/:id',
    requirePermission('team.update'),
    ...handle({ params: IdParams, body: UpdateMemberBody }, async ({ params, body, req, res }) => {
      ok(res, await updateMember(req, params.id, body));
    }),
  );
  router.delete(
    '/users/:id',
    requirePermission('team.remove'),
    ...handle({ params: IdParams }, async ({ params, req, res }) => {
      await removeMember(req, params.id);
      noContent(res);
    }),
  );
  router.post(
    '/transfer-ownership',
    blockWhenImpersonating(),
    ...handle({ body: TransferOwnershipBody }, async ({ body, req, res }) => {
      ok(res, await transferOwnership(req, body));
    }),
  );
  return router;
};
