import { Router, type RequestHandler } from 'express';
import { Types } from 'mongoose';
import multer, { memoryStorage, MulterError } from 'multer';

import { requireAuth } from '../../shared/auth/auth-context';
import { AppError, ValidationError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import {
  blockWhenImpersonating,
  requirePermission,
} from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';
import { BusinessProfilePatchBody } from '../inbox/inbox.schema';

import type { WaActor } from './channel-status';
import type { WhatsAppContext } from './context';
import {
  getBusinessProfile,
  PROFILE_PHOTO,
  updateBusinessProfile,
  updateProfilePhoto,
} from './profile.service';
import { ChannelParams } from './whatsapp.schema';

const upload = multer({
  storage: memoryStorage(),
  limits: { fileSize: PROFILE_PHOTO.maxBytes, files: 1, fields: 0, parts: 1 },
}).single('file');

const uploadPhoto: RequestHandler = (req, res, next) => {
  upload(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof MulterError) {
      next(
        err.code === 'LIMIT_FILE_SIZE'
          ? new AppError('WHATSAPP_MEDIA_TOO_LARGE', undefined, [
              { path: 'file', message: `At most ${String(PROFILE_PHOTO.maxBytes)} bytes` },
            ])
          : new ValidationError([{ path: 'file', message: 'Upload one file named "file"' }]),
      );
      return;
    }
    next(err);
  });
};

/** `/api/v1/whatsapp/channels/:id/profile` — business profile (read `whatsapp.read`, edit `whatsapp.manage`). */
export const createBusinessProfileRouter = (ctx: WhatsAppContext): Router => {
  const router = Router();
  router.use(authenticate());
  const manage = [
    requirePermission('whatsapp.manage'),
    blockWhenImpersonating(),
  ] as RequestHandler[];
  const actorOf = (userId: string | undefined): WaActor => ({
    type: 'user',
    id: userId ? new Types.ObjectId(userId) : null,
  });
  router.get(
    '/channels/:id/profile',
    requirePermission('whatsapp.read'),
    ...handle({ params: ChannelParams }, async ({ params, req, res }) => {
      ok(
        res,
        await getBusinessProfile(ctx, new Types.ObjectId(requireAuth(req).accountId), params.id),
      );
    }),
  );
  router.patch(
    '/channels/:id/profile',
    ...manage,
    ...handle(
      { params: ChannelParams, body: BusinessProfilePatchBody },
      async ({ params, body, req, res }) => {
        const auth = requireAuth(req);
        ok(
          res,
          await updateBusinessProfile(
            ctx,
            new Types.ObjectId(auth.accountId),
            params.id,
            body,
            actorOf(auth.userId),
          ),
        );
      },
    ),
  );
  router.post(
    '/channels/:id/profile/photo',
    ...manage,
    uploadPhoto,
    ...handle({ params: ChannelParams }, async ({ params, req, res }) => {
      const auth = requireAuth(req);
      if (!req.file)
        throw new ValidationError([{ path: 'file', message: 'Upload one file named "file"' }]);
      ok(
        res,
        await updateProfilePhoto(
          ctx,
          new Types.ObjectId(auth.accountId),
          params.id,
          req.file.buffer,
          actorOf(auth.userId),
        ),
      );
    }),
  );
  return router;
};
