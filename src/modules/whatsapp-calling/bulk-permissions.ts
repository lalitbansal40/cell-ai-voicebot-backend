import { createHash } from 'node:crypto';

import { Types } from 'mongoose';

import { notifyAccount } from '../../core/realtime/notify';
import {
  CallPermissionRunModel,
  type CallPermissionRunDoc,
  type CallPermissionRunTarget,
  type CallPermissionSkipReason,
} from '../../db/models/call-permission-run.model';
import { ContactListModel } from '../../db/models/contact-list.model';
import { ContactModel, type ContactDoc } from '../../db/models/contact.model';
import {
  WhatsAppCallPermissionModel,
  type WhatsAppCallPermissionDoc,
} from '../../db/models/whatsapp-call-permission.model';
import { WhatsAppTemplateModel } from '../../db/models/whatsapp-template.model';
import { AppError, NotFoundError, ValidationError } from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger';
import { recordAudit } from '../audit/audit.service';
import { segmentQuery } from '../contacts/contacts.service';
import { loadContactContext } from '../contacts/context';
import { notify } from '../notifications/notifications.service';
import { suppressedPhones } from '../privacy/suppression';

import type { CallingJobs } from './jobs';
import type { CallPermissionsService, PermissionActor } from './permissions.service';

/** PHASE_18B_PROMPT §1: one run asks at most 5,000 contacts, 50 per batch. */
export const BULK_PERMISSION_LIMITS = { maxContacts: 5_000, batchSize: 50 } as const;
const DECLINED_RECENTLY_MS = 7 * 86_400_000;

export interface BulkPermissionInput {
  /** Internal campaign batch identity, never accepted from the HTTP body. */
  runId?: string;
  channelId: string;
  target: { contactIds?: string[]; listId?: string; segmentId?: string };
  templateId: string;
  variables?: Record<string, string>;
}

/** Stable UUID per run + contact (`cpb:<runId>:<contactId>`): a retried job never sends twice. */
export const bulkClientId = (runId: string, contactId: string): string => {
  const hex = createHash('sha1').update(`cpb:${runId}:${contactId}`).digest('hex');
  const variant = ((parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/** The run as the API returns it (no contact ids). */
export const runJson = (run: CallPermissionRunDoc) => ({
  id: run._id.toString(),
  channelId: run.channelId.toString(),
  templateId: run.templateId.toString(),
  status: run.status,
  total: run.total,
  sent: run.sent,
  skipped: run.skipped,
  failed: run.failed,
  startedAt: run.startedAt?.toISOString() ?? null,
  finishedAt: run.finishedAt?.toISOString() ?? null,
  createdAt: run.createdAt.toISOString(),
});

/**
 * Skip rules before anything is sent, in the prompt's order: suppressed, dnd, opted out,
 * no WhatsApp (blocked us), already allowed, declined in the last 7 days.
 */
export const skipReasonFor = (
  contact: Pick<ContactDoc, 'phoneE164' | 'dnd' | 'optedOutAt' | 'whatsapp'>,
  row: Pick<WhatsAppCallPermissionDoc, 'status' | 'expiresAt' | 'history' | 'updatedAt'> | null,
  suppressed: boolean,
  valid: (r: Pick<WhatsAppCallPermissionDoc, 'status' | 'expiresAt'> | null, now: Date) => boolean,
  now: Date,
): CallPermissionSkipReason | null => {
  if (suppressed) return 'suppressed';
  if (contact.dnd) return 'dnd';
  if (contact.optedOutAt) return 'opted_out';
  if (contact.whatsapp?.blocked) return 'no_whatsapp';
  if (valid(row, now)) return 'already_allowed';
  if (row?.status === 'declined') {
    const at =
      [...(row.history ?? [])].reverse().find((h) => h.status === 'declined')?.at ?? row.updatedAt;
    if (at && now.getTime() - at.getTime() < DECLINED_RECENTLY_MS) return 'declined_recently';
  }
  return null;
};

/** A refused single request → the bulk outcome (Meta's 138009 / 138017 are answers, not failures). */
const outcomeOf = (err: unknown): CallPermissionSkipReason | 'failed' | 'stop' => {
  if (!(err instanceof AppError)) return 'failed';
  switch (err.code) {
    case 'WALLET_INSUFFICIENT_BALANCE':
    case 'WALLET_BUDGET_EXCEEDED':
      return 'stop';
    case 'WHATSAPP_CALL_PERMISSION_EXISTS':
      return 'already_allowed';
    case 'WHATSAPP_CALL_PERMISSION_LIMIT':
      return 'meta_limit';
    case 'CALL_NOT_ALLOWED': {
      const why = err.details?.[0]?.message;
      return why === 'dnd' ? 'dnd' : why === 'opted_out' ? 'opted_out' : 'no_whatsapp';
    }
    default:
      return 'failed';
  }
};

const BULK_DONE_TITLE = 'Call permission requests sent';

export const createBulkPermissions = (deps: {
  permissions: CallPermissionsService;
  jobs?: CallingJobs;
  now?: () => Date;
}) => {
  const now = () => deps.now?.() ?? new Date();

  /** Target → live contact ids of the account (≤ 5,000, oldest first). */
  const resolveTarget = async (
    accountId: Types.ObjectId,
    target: BulkPermissionInput['target'],
  ): Promise<{ ids: Types.ObjectId[]; target: CallPermissionRunTarget }> => {
    const given = [target.contactIds, target.listId, target.segmentId].filter(
      (v) => v !== undefined,
    );
    if (given.length !== 1) {
      throw new ValidationError([
        { path: 'target', message: 'Give exactly one of contactIds, listId or segmentId' },
      ]);
    }
    const base = { accountId, deletedAt: null };
    let query: Record<string, unknown>;
    let runTarget: CallPermissionRunTarget;
    if (target.contactIds) {
      const ids = [...new Set(target.contactIds)].map((id) => new Types.ObjectId(id));
      query = { ...base, _id: { $in: ids } };
      runTarget = { type: 'contacts', count: ids.length };
    } else if (target.listId) {
      const listId = new Types.ObjectId(target.listId);
      const list = await ContactListModel.exists({ _id: listId, accountId });
      if (!list) throw new ValidationError([{ path: 'target.listId', message: 'Unknown list' }]);
      query = { ...base, listIds: listId };
      runTarget = { type: 'list', id: listId };
    } else {
      const segmentId = String(target.segmentId);
      const ctx = await loadContactContext(accountId);
      query = { $and: [base, await segmentQuery(ctx, segmentId)] };
      runTarget = { type: 'segment', id: new Types.ObjectId(segmentId) };
    }
    const rows = await ContactModel.find(query)
      .select({ _id: 1 })
      .sort({ _id: 1 })
      .limit(BULK_PERMISSION_LIMITS.maxContacts)
      .lean<{ _id: Types.ObjectId }[]>();
    return { ids: rows.map((r) => r._id), target: runTarget };
  };

  /** `POST /whatsapp/call-permissions/bulk`: validates, stores the run, queues the job. */
  const start = async (
    actor: PermissionActor & { userId: Types.ObjectId },
    input: BulkPermissionInput,
  ) => {
    if (input.runId) {
      const existing = await CallPermissionRunModel.findOne({
        _id: input.runId,
        accountId: actor.accountId,
      }).lean();
      if (existing) {
        if (deps.jobs && !['done', 'stopped'].includes(existing.status))
          await deps.jobs.enqueuePermissionBulk(existing._id.toString());
        return { runId: existing._id.toString() };
      }
      if (await CallPermissionRunModel.exists({ _id: input.runId })) throw new NotFoundError();
    }
    const channel = await deps.permissions.loadChannel(actor.accountId, input.channelId);
    const block = deps.permissions.channelBlock(channel, now());
    if (block === 'calling_unavailable' || block === 'country' || block === 'not_connected') {
      throw new AppError('WHATSAPP_CALLING_UNAVAILABLE', undefined, [
        { path: 'channelId', message: block },
      ]);
    }
    if (block === 'calling_disabled') throw new AppError('WHATSAPP_CALLING_DISABLED');
    if (block === 'restricted') throw new AppError('WHATSAPP_CALLING_RESTRICTED');
    const template = Types.ObjectId.isValid(input.templateId)
      ? await WhatsAppTemplateModel.findOne({
          _id: new Types.ObjectId(input.templateId),
          accountId: actor.accountId,
          wabaId: channel.wabaId,
        })
          .select({ purpose: 1, status: 1 })
          .lean<{ _id: Types.ObjectId; purpose?: string | null; status: string }>()
      : null;
    if (!template) {
      throw new ValidationError([
        { path: 'templateId', message: 'Unknown template on this number' },
      ]);
    }
    if (template.purpose !== 'call_permission') {
      throw new ValidationError([
        { path: 'templateId', message: 'Pick a call permission template' },
      ]);
    }
    if (template.status !== 'APPROVED') {
      throw new ValidationError([
        { path: 'templateId', message: 'The template is not approved yet' },
      ]);
    }
    const { ids, target } = await resolveTarget(actor.accountId, input.target);
    if (!ids.length) {
      throw new ValidationError([{ path: 'target', message: 'No contacts to ask' }]);
    }
    const run = await CallPermissionRunModel.create({
      ...(input.runId ? { _id: new Types.ObjectId(input.runId) } : {}),
      accountId: actor.accountId,
      channelId: channel._id,
      templateId: template._id,
      variables: input.variables ?? {},
      target,
      contactIds: ids,
      total: ids.length,
      createdBy: actor.userId,
    });
    await recordAudit({
      accountId: actor.accountId,
      actor: {
        type: actor.type,
        id: actor.id ?? actor.userId,
        impersonatorId: actor.impersonatorId ?? null,
      },
      action: 'whatsapp.call_permission_bulk_requested',
      target: { type: 'whatsapp_channel', id: channel._id.toString() },
      meta: { runId: run._id.toString(), total: ids.length, channelId: channel._id.toString() },
      ip: actor.ip ?? null,
    });
    if (deps.jobs) await deps.jobs.enqueuePermissionBulk(run._id.toString());
    return { runId: run._id.toString() };
  };

  const get = async (accountId: Types.ObjectId, runId: string) => {
    const run = Types.ObjectId.isValid(runId)
      ? await CallPermissionRunModel.findOne({
          _id: new Types.ObjectId(runId),
          accountId,
        }).lean<CallPermissionRunDoc>()
      : null;
    if (!run) throw new NotFoundError('Run not found');
    return runJson(run);
  };

  const progress = (
    run: Pick<
      CallPermissionRunDoc,
      '_id' | 'accountId' | 'status' | 'total' | 'sent' | 'failed' | 'skipped'
    >,
  ) =>
    notifyAccount(run.accountId.toString(), 'call_permission_bulk.progress', {
      runId: run._id.toString(),
      status: run.status,
      total: run.total,
      sent: run.sent,
      failed: run.failed,
      skipped: run.skipped as Record<string, number>,
    });

  /** The `call-permission-bulk` job: resumes at the cursor, saves after every batch. */
  const process = async (runId: string): Promise<{ status: string }> => {
    const run = await CallPermissionRunModel.findById(runId).lean<CallPermissionRunDoc>();
    if (!run) return { status: 'missing' };
    if (run.status === 'done' || run.status === 'stopped') return { status: run.status };
    const startedAt = run.startedAt ?? now();
    if (run.status === 'queued') {
      await CallPermissionRunModel.updateOne(
        { _id: run._id },
        { $set: { status: 'running', startedAt } },
      );
    }
    const actor = {
      type: 'user' as const,
      id: run.createdBy,
      userId: run.createdBy,
      accountId: run.accountId,
      impersonatorId: null,
      ip: null,
    };
    const state = {
      sent: run.sent,
      failed: run.failed,
      skipped: { ...run.skipped } as Partial<Record<CallPermissionSkipReason, number>>,
    };
    const skip = (reason: CallPermissionSkipReason, n = 1) => {
      state.skipped[reason] = (state.skipped[reason] ?? 0) + n;
    };
    let cursor = run.cursor;
    let stopped = false;
    const ids = run.contactIds;
    while (cursor < ids.length && !stopped) {
      const batch = ids.slice(cursor, cursor + BULK_PERMISSION_LIMITS.batchSize);
      const contacts = await ContactModel.find({
        _id: { $in: batch },
        accountId: run.accountId,
        deletedAt: null,
      })
        .select({ phoneE164: 1, dnd: 1, optedOutAt: 1, whatsapp: 1 })
        .lean<ContactDoc[]>();
      const byId = new Map(contacts.map((c) => [c._id.toString(), c]));
      const suppressed = await suppressedPhones(
        run.accountId,
        contacts.map((c) => c.phoneE164),
      );
      const rows = await WhatsAppCallPermissionModel.find({
        accountId: run.accountId,
        channelId: run.channelId,
        contactId: { $in: batch },
      }).lean<WhatsAppCallPermissionDoc[]>();
      const rowOf = new Map(rows.map((r) => [r.contactId.toString(), r]));
      let handled = 0;
      for (const id of batch) {
        const key = id.toString();
        const contact = byId.get(key);
        const row = rowOf.get(key) ?? null;
        handled += 1;
        if (!contact) {
          // erased / deleted since the run started
          skip('suppressed');
          continue;
        }
        // a retry after a crash: this run already asked this contact
        if (
          row?.status === 'requested' &&
          row.lastRequest &&
          row.lastRequest.at.getTime() >= startedAt.getTime()
        ) {
          state.sent += 1;
          continue;
        }
        const reason = skipReasonFor(
          contact,
          row,
          suppressed.has(contact.phoneE164),
          deps.permissions.valid,
          now(),
        );
        if (reason) {
          skip(reason);
          continue;
        }
        try {
          await deps.permissions.request(actor, {
            channelId: run.channelId.toString(),
            contactId: key,
            forceTemplate: true,
            bulk: true,
            templateId: run.templateId.toString(),
            ...(Object.keys(run.variables ?? {}).length ? { variables: run.variables } : {}),
            clientId: bulkClientId(run._id.toString(), key),
          });
          state.sent += 1;
        } catch (err) {
          const outcome = outcomeOf(err);
          if (outcome === 'stop') {
            // the wallet is empty: this one and every one after it are not asked
            skip('wallet_empty', ids.length - (cursor + handled) + 1);
            stopped = true;
            break;
          }
          if (outcome === 'failed') {
            state.failed += 1;
            getLogger().warn(
              { err, runId: run._id.toString() },
              'whatsapp calling: bulk permission request failed',
            );
          } else skip(outcome);
        }
      }
      cursor = stopped ? ids.length : cursor + batch.length;
      const done = cursor >= ids.length;
      const status = stopped ? 'stopped' : done ? 'done' : 'running';
      await CallPermissionRunModel.updateOne(
        { _id: run._id },
        {
          $set: {
            cursor,
            sent: state.sent,
            failed: state.failed,
            skipped: state.skipped,
            status,
            ...(done ? { finishedAt: now() } : {}),
          },
        },
      );
      progress({ ...run, status, ...state });
    }
    if (cursor >= ids.length && run.cursor >= ids.length && !stopped) {
      // nothing was left (an empty retry): close the run
      await CallPermissionRunModel.updateOne(
        { _id: run._id },
        { $set: { status: 'done', finishedAt: now() } },
      );
    }
    const finalStatus = stopped ? 'stopped' : 'done';
    const skippedTotal = Object.values(state.skipped).reduce((a, b) => a + (b ?? 0), 0);
    try {
      await notify({
        accountId: run.accountId,
        userIds: [run.createdBy],
        type: 'whatsapp.call_permission_bulk_done',
        title: BULK_DONE_TITLE,
        body: `${state.sent} sent, ${skippedTotal} skipped, ${state.failed} failed${stopped ? ' (stopped: wallet empty)' : ''}.`,
        link: '/contacts',
      });
    } catch (err) {
      getLogger().error({ err }, 'whatsapp calling: bulk permission bell failed');
    }
    return { status: finalStatus };
  };

  return { start, get, process, resolveTarget };
};

export type BulkPermissionsService = ReturnType<typeof createBulkPermissions>;
