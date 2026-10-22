import { Router, type Request, type RequestHandler } from 'express';
import type { Store } from 'express-rate-limit';
import { Types } from 'mongoose';
import multer, { memoryStorage, MulterError } from 'multer';

import { INBOX_LIMITS } from '../../config/limits';
import type { StorageProvider } from '../../core/storage';
import { UserModel } from '../../db/models/user.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { AppError, ValidationError } from '../../shared/errors/app-error';
import { created, noContent, ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import { createRateLimiter } from '../../shared/middlewares/rate-limit';
import {
  blockWhenImpersonating,
  requireAnyPermission,
  requirePermission,
} from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';
import type { WhatsAppContext } from '../whatsapp/context';

import type { InboxContext } from './context';
import {
  assignConversation,
  findMessage,
  getContactPanel,
  getConversation,
  inboxSummary,
  listConversations,
  listMessages,
  setBlocked,
  setConversationStatus,
  startConversation,
  type InboxActor,
} from './conversations.service';
import { toMessageView } from './inbox-json';
import {
  AssignBody,
  ConversationParams,
  ListConversationsQuery,
  ListMessagesQuery,
  MessageParams,
  StartConversationBody,
  UploadFields,
} from './inbox.schema';
import type { InboxJobs } from './jobs';
import { mediaLink, retryMediaDownload } from './media.service';
import { SendMessageBody } from './outbound.schema';
import { retryMessage, sendMessage } from './outbound.service';
import { markConversationRead, markConversationUnread, sendTyping } from './receipts';
import { createUpload, UPLOAD_PARSER_MAX_BYTES } from './upload.service';

export interface InboxRouterDeps {
  ctx: WhatsAppContext;
  storage?: StorageProvider | undefined;
  jobs: InboxJobs;
  /** `rl:inbox-send:` / `rl:inbox-upload:` stores (MemoryStore when omitted). */
  sendRateLimitStore?: Store;
  uploadRateLimitStore?: Store;
}

export const actorOf = (req: Request): InboxActor => {
  const auth = requireAuth(req);
  const userId = new Types.ObjectId(auth.userId);
  return {
    accountId: new Types.ObjectId(auth.accountId),
    userId,
    type: 'user',
    id: userId,
    impersonatorId: auth.impersonatorId ?? null,
    ip: req.ip ?? null,
  };
};

const upload = multer({
  storage: memoryStorage(),
  limits: { fileSize: UPLOAD_PARSER_MAX_BYTES, files: 1, fields: 4, parts: 5 },
}).single('file');

/** multer → our envelope: too large = 413, odd parts = 422. */
const uploadFile: RequestHandler = (req, res, next) => {
  upload(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof MulterError) {
      next(
        err.code === 'LIMIT_FILE_SIZE'
          ? new AppError('WHATSAPP_MEDIA_TOO_LARGE', undefined, [
              { path: 'file', message: `At most ${String(UPLOAD_PARSER_MAX_BYTES)} bytes` },
            ])
          : new ValidationError([{ path: 'file', message: 'Upload one file named "file"' }]),
      );
      return;
    }
    next(err);
  });
};

/**
 * `/api/v1/inbox` (PHASE_10_PLAN §1n): conversations of the caller's account. Reads
 * need `inbox.read`; replies / notes / close `inbox.reply`; assigning others,
 * blocking and media retries `inbox.assign`; no writes while impersonating;
 * suspended accounts are read only (`authenticate`).
 */
export const createInboxRouter = (deps: InboxRouterDeps): Router => {
  const router = Router();
  router.use(authenticate());
  const ix = (): InboxContext => {
    if (!deps.storage)
      throw new AppError('PROVIDER_UNAVAILABLE', 'File storage is not configured.');
    return { wa: deps.ctx, storage: deps.storage, jobs: deps.jobs };
  };
  const read = requirePermission('inbox.read');
  const reply = [requirePermission('inbox.reply'), blockWhenImpersonating()] as RequestHandler[];
  const assign = [requirePermission('inbox.assign'), blockWhenImpersonating()] as RequestHandler[];
  const sendLimit = createRateLimiter({
    windowMs: 60_000,
    limit: INBOX_LIMITS.sendsPerMinutePerUser,
    keyGenerator: (req) => `inbox-send:${req.auth?.userId ?? 'anonymous'}`,
    ...(deps.sendRateLimitStore ? { store: deps.sendRateLimitStore } : {}),
  });
  const uploadLimit = createRateLimiter({
    windowMs: 60_000,
    limit: INBOX_LIMITS.uploadsPerMinutePerUser,
    keyGenerator: (req) => `inbox-upload:${req.auth?.userId ?? 'anonymous'}`,
    ...(deps.uploadRateLimitStore ? { store: deps.uploadRateLimitStore } : {}),
  });

  router.get('/config', read, (_req, res) => {
    ok(res, {
      retentionDays: deps.ctx.env.INBOX_RETENTION_DAYS,
      fakeProvider: deps.ctx.meta.provider === 'fake',
      limits: {
        textMax: INBOX_LIMITS.textMax,
        captionMax: INBOX_LIMITS.captionMax,
        imageMaxBytes: INBOX_LIMITS.imageMaxBytes,
        videoMaxBytes: INBOX_LIMITS.videoMaxBytes,
        audioMaxBytes: INBOX_LIMITS.audioMaxBytes,
        stickerMaxBytes: INBOX_LIMITS.stickerMaxBytes,
        documentMaxBytes: INBOX_LIMITS.documentMaxBytes,
        buttonsMax: INBOX_LIMITS.buttonsMax,
        buttonTitleMax: INBOX_LIMITS.buttonTitleMax,
        listRowsMax: INBOX_LIMITS.listRowsMax,
        listSectionsMax: INBOX_LIMITS.listSectionsMax,
        rowTitleMax: INBOX_LIMITS.rowTitleMax,
        rowDescriptionMax: INBOX_LIMITS.rowDescriptionMax,
        headerTextMax: INBOX_LIMITS.headerTextMax,
        footerMax: INBOX_LIMITS.footerMax,
        bodyMax: INBOX_LIMITS.bodyMax,
        ctaTextMax: INBOX_LIMITS.ctaTextMax,
        contactsMax: INBOX_LIMITS.contactsMax,
        voiceNoteMaxSeconds: INBOX_LIMITS.voiceNoteMaxSeconds,
        voiceNoteMinMs: INBOX_LIMITS.voiceNoteMinMs,
        typingThrottleMs: INBOX_LIMITS.typingThrottleMs,
      },
    });
  });
  router.get('/summary', read, async (req, res) => {
    ok(res, await inboxSummary(actorOf(req)));
  });
  router.get(
    '/conversations',
    read,
    ...handle({ query: ListConversationsQuery }, async ({ query, req, res }) => {
      const page = await listConversations(ix(), actorOf(req), query);
      ok(res, page.items, { nextCursor: page.nextCursor });
    }),
  );
  // static paths before `/:id`
  router.post(
    '/conversations/start',
    ...reply,
    ...handle({ body: StartConversationBody }, async ({ body, req, res }) => {
      const r = await startConversation(ix(), actorOf(req), body);
      if (r.created) created(res, r);
      else ok(res, r);
    }),
  );
  router.get(
    '/conversations/:id',
    read,
    ...handle({ params: ConversationParams }, async ({ params, req, res }) => {
      ok(res, await getConversation(ix(), actorOf(req), params.id));
    }),
  );
  router.get(
    '/conversations/:id/messages',
    read,
    ...handle(
      { params: ConversationParams, query: ListMessagesQuery },
      async ({ params, query, req, res }) => {
        const page = await listMessages(ix(), actorOf(req), params.id, query);
        ok(res, page.items, { olderCursor: page.olderCursor, hasNewer: page.hasNewer });
      },
    ),
  );
  router.get(
    '/conversations/:id/contact',
    read,
    ...handle({ params: ConversationParams }, async ({ params, req, res }) => {
      ok(res, await getContactPanel(ix(), actorOf(req), params.id));
    }),
  );
  router.post(
    '/conversations/:id/messages',
    ...reply,
    sendLimit,
    ...handle(
      { params: ConversationParams, body: SendMessageBody },
      async ({ params, body, req, res }) => {
        const r = await sendMessage(ix(), actorOf(req), params.id, body);
        const view = toMessageView(r.message);
        if (r.created) created(res, view);
        else ok(res, view);
      },
    ),
  );
  router.post(
    '/conversations/:id/read',
    read,
    ...handle({ params: ConversationParams }, async ({ params, req, res }) => {
      const auth = requireAuth(req);
      await markConversationRead(ix(), {
        ...actorOf(req),
        conversationId: params.id,
        impersonating: Boolean(auth.impersonatorId),
      });
      noContent(res);
    }),
  );
  router.post(
    '/conversations/:id/unread',
    read,
    blockWhenImpersonating(),
    ...handle({ params: ConversationParams }, async ({ params, req, res }) => {
      await markConversationUnread({
        accountId: actorOf(req).accountId,
        conversationId: params.id,
      });
      noContent(res);
    }),
  );
  router.post(
    '/conversations/:id/typing',
    ...reply,
    ...handle({ params: ConversationParams }, async ({ params, req, res }) => {
      const actor = actorOf(req);
      const user = await UserModel.findById(actor.userId)
        .select({ name: 1 })
        .lean<{ name: string }>();
      ok(
        res,
        await sendTyping(ix(), {
          accountId: actor.accountId,
          user: { id: actor.userId.toString(), name: user?.name ?? '' },
          conversationId: params.id,
        }),
      );
    }),
  );
  router.patch(
    '/conversations/:id',
    requireAnyPermission('inbox.assign', 'inbox.reply'),
    blockWhenImpersonating(),
    ...handle(
      { params: ConversationParams, body: AssignBody },
      async ({ params, body, req, res }) => {
        const canAssignOthers = requireAuth(req).permissions.has('inbox.assign');
        ok(
          res,
          await assignConversation(
            ix(),
            { ...actorOf(req), canAssignOthers },
            params.id,
            body.assignedTo,
          ),
        );
      },
    ),
  );
  for (const [path, status] of [
    ['close', 'closed'],
    ['reopen', 'open'],
  ] as const) {
    router.post(
      `/conversations/:id/${path}`,
      ...reply,
      ...handle({ params: ConversationParams }, async ({ params, req, res }) => {
        ok(res, await setConversationStatus(ix(), actorOf(req), params.id, status));
      }),
    );
  }
  for (const [path, blocked] of [
    ['block', true],
    ['unblock', false],
  ] as const) {
    router.post(
      `/conversations/:id/${path}`,
      ...assign,
      ...handle({ params: ConversationParams }, async ({ params, req, res }) => {
        ok(res, await setBlocked(ix(), actorOf(req), params.id, blocked));
      }),
    );
  }
  router.post('/media', ...reply, uploadLimit, uploadFile, async (req, res) => {
    const fields = UploadFields.safeParse(req.body);
    if (!fields.success) {
      throw new ValidationError(
        fields.error.issues.map((i) => ({ path: String(i.path[0] ?? 'kind'), message: i.message })),
      );
    }
    const file = req.file;
    if (!file)
      throw new ValidationError([{ path: 'file', message: 'Upload one file named "file"' }]);
    const actor = actorOf(req);
    const u = await createUpload(ix(), {
      accountId: actor.accountId,
      userId: actor.userId,
      kind: fields.data.kind,
      bytes: file.buffer,
      declaredMime: file.mimetype,
      fileName: file.originalname,
      durationSec: fields.data.durationSec ?? null,
    });
    created(res, {
      mediaToken: u._id.toString(),
      kind: u.kind,
      mimeType: u.mimeType,
      size: u.size,
      fileName: u.fileName,
      durationSec: u.durationSec,
      voice: u.voice,
      expiresAt: u.expiresAt.toISOString(),
    });
  });
  router.get(
    '/messages/:id/media',
    read,
    ...handle({ params: MessageParams }, async ({ params, req, res }) => {
      const m = await findMessage(actorOf(req), params.id);
      ok(res, {
        url: await mediaLink(ix(), m),
        mimeType: m.media?.mimeType ?? null,
        fileName: m.media?.fileName ?? null,
        expiresInSec: INBOX_LIMITS.mediaLinkTtlSec,
      });
    }),
  );
  router.post(
    '/messages/:id/retry',
    ...reply,
    sendLimit,
    ...handle({ params: MessageParams }, async ({ params, req, res }) => {
      created(res, toMessageView(await retryMessage(ix(), actorOf(req), params.id)));
    }),
  );
  router.post(
    '/messages/:id/media/retry',
    ...assign,
    ...handle({ params: MessageParams }, async ({ params, req, res }) => {
      const m = await findMessage(actorOf(req), params.id);
      await retryMediaDownload(ix(), m);
      noContent(res);
    }),
  );
  return router;
};

/** `/api/v1/inbox` when WhatsApp is off: every route 503 `WHATSAPP_NOT_CONFIGURED`. */
export const createInboxDisabledRouter = (): Router => {
  const router = Router();
  router.use(authenticate());
  router.use(() => {
    throw new AppError('WHATSAPP_NOT_CONFIGURED');
  });
  return router;
};
