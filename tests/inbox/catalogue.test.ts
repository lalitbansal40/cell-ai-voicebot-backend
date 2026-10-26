import { describe, expect, it } from 'vitest';

import { INBOX_LIMITS } from '../../src/config/limits';
import { META_MEDIA_HOST_SUFFIXES } from '../../src/core/meta';
import { WS_EVENT_TYPES } from '../../src/core/realtime/events';
import { parseTopic } from '../../src/core/realtime/topics';
import { DEFAULT_INBOX_SETTINGS, INBOX_NOTIFY_MODES } from '../../src/db/models/account.model';
import { CONTACT_SOURCE_TYPES, EMPTY_CONTACT_WHATSAPP } from '../../src/db/models/contact.model';
import {
  CONVERSATION_SOURCES,
  CONVERSATION_STATUSES,
} from '../../src/db/models/conversation.model';
import { DND_SOURCES } from '../../src/db/models/dnd-entry.model';
import { UPLOAD_KINDS } from '../../src/db/models/inbox-upload.model';
import {
  INTERACTIVE_KINDS,
  MEDIA_STATUSES,
  MESSAGE_ORIGINS,
  MESSAGE_STATUSES,
  MESSAGE_TYPES,
} from '../../src/db/models/message.model';
import { NOTIFICATION_TYPES } from '../../src/db/models/notification.model';
import { AUDIT_ACTIONS } from '../../src/modules/audit/audit-actions';
import {
  BACKFILL_JOB_ID,
  historyImportJobId,
  INBOX_JOBS,
  INBOX_RETENTION_CRON,
  INBOX_RETENTION_JOB,
  mediaDownloadJobId,
  readReceiptJobId,
  sendJobId,
} from '../../src/modules/inbox/jobs';
import { PERMISSIONS } from '../../src/modules/rbac/permissions';
import { SYSTEM_ROLES } from '../../src/modules/rbac/system-roles';
import { AppError } from '../../src/shared/errors/app-error';
import { ERROR_CODES } from '../../src/shared/errors/error-codes';

describe('Phase 10 catalogue', () => {
  it('has the five inbox error codes (count: Phase 11 catalogue test)', () => {
    expect(
      (
        [
          'WHATSAPP_WINDOW_CLOSED',
          'WHATSAPP_RECIPIENT_BLOCKED',
          'WHATSAPP_MEDIA_INVALID',
          'WHATSAPP_MEDIA_TOO_LARGE',
          'INBOX_MEDIA_EXPIRED',
        ] as const
      ).map((k) => [k, ERROR_CODES[k].status]),
    ).toEqual([
      ['WHATSAPP_WINDOW_CLOSED', 409],
      ['WHATSAPP_RECIPIENT_BLOCKED', 409],
      ['WHATSAPP_MEDIA_INVALID', 422],
      ['WHATSAPP_MEDIA_TOO_LARGE', 413],
      ['INBOX_MEDIA_EXPIRED', 410],
    ]);
    expect(new AppError('WHATSAPP_WINDOW_CLOSED').message).toContain('24-hour window is closed');
  });

  it('has the eleven inbox audit actions (count: Phase 11 catalogue test)', () => {
    expect(
      AUDIT_ACTIONS.filter((a) => a.startsWith('inbox.') || a === 'whatsapp.profile_updated'),
    ).toEqual([
      'inbox.conversation_assigned',
      'inbox.conversation_closed',
      'inbox.conversation_reopened',
      'inbox.contact_opted_out',
      'inbox.contact_opted_in',
      'inbox.contact_blocked',
      'inbox.contact_unblocked',
      'inbox.history_imported',
      'inbox.messages_purged',
      'inbox.settings_updated',
      'whatsapp.profile_updated',
    ]);
  });

  it('has the two inbox notification types and the five inbox WS events', () => {
    expect(NOTIFICATION_TYPES.filter((t) => t.startsWith('inbox.'))).toEqual([
      'inbox.message_received',
      'inbox.conversation_assigned',
    ]);
    expect(WS_EVENT_TYPES.filter((t) => t.startsWith('inbox.'))).toEqual([
      'inbox.conversation.updated',
      'inbox.summary.updated',
      'inbox.message.created',
      'inbox.message.updated',
      'inbox.typing',
      // Phase 14 chat summaries
      'inbox.conversation.summary',
    ]);
  });

  it('inbox permissions per role', () => {
    expect(PERMISSIONS).toEqual(
      expect.arrayContaining(['inbox.read', 'inbox.reply', 'inbox.assign']),
    );
    const roles = ['owner', 'admin', 'manager', 'agent', 'viewer'] as const;
    const has = (p: string) =>
      roles.map((r) => (SYSTEM_ROLES[r].permissions as string[]).includes(p));
    expect(has('inbox.read')).toEqual([true, true, true, true, true]);
    expect(has('inbox.reply')).toEqual([true, true, true, true, false]);
    expect(has('inbox.assign')).toEqual([true, true, true, false, false]);
  });

  it('conversation topics parse; other kinds do not', () => {
    const id = 'a'.repeat(24);
    expect(parseTopic(`conversation:${id}`)).toEqual({ kind: 'conversation', id });
    expect(parseTopic(`CONVERSATION:${id.toUpperCase()}`)).toEqual({ kind: 'conversation', id });
    expect(parseTopic('conversation:123')).toBeUndefined();
    expect(parseTopic(`chat:${id}`)).toBeUndefined();
  });

  it('job names and ids (no `:` — BullMQ)', () => {
    expect(INBOX_JOBS).toEqual({
      messageSend: 'message.send',
      mediaDownload: 'media.download',
      readReceipt: 'read.receipt',
      backfill: 'inbox.backfill',
      historyImport: 'inbox.history-import',
    });
    const ids = [
      sendJobId('m1'),
      mediaDownloadJobId('m1'),
      readReceiptJobId('m1'),
      BACKFILL_JOB_ID,
      historyImportJobId('e1'),
      INBOX_RETENTION_JOB,
    ];
    expect(ids).toEqual([
      'msg-send-m1',
      'media-dl-m1',
      'read-receipt-m1',
      'inbox-backfill',
      'history-import-e1',
      'inbox-retention',
    ]);
    for (const id of ids) expect(id).not.toContain(':');
    expect(INBOX_RETENTION_CRON).toBe('50 5 * * *');
  });

  it('model constants, defaults and limits', () => {
    expect(CONVERSATION_STATUSES).toEqual(['open', 'closed']);
    expect(CONVERSATION_SOURCES).toEqual(['inbound', 'outbound', 'business_app', 'history']);
    // `api` + `template` arrive in Phase 11 (counts: Phase 11 catalogue test)
    expect(MESSAGE_ORIGINS).toEqual(
      expect.arrayContaining(['customer', 'agent', 'business_app', 'history', 'system']),
    );
    expect(MESSAGE_TYPES).toEqual(expect.arrayContaining(['text', 'interactive', 'reaction']));
    expect(MESSAGE_TYPES).toContain('note');
    expect(MESSAGE_STATUSES).toEqual([
      'received',
      'queued',
      'accepted',
      'sent',
      'delivered',
      'read',
      'failed',
      'deleted',
    ]);
    expect(MEDIA_STATUSES).toEqual(['pending', 'ready', 'failed', 'expired']);
    expect(INTERACTIVE_KINDS).toContain('nfm_reply');
    expect(UPLOAD_KINDS).toEqual(['image', 'video', 'audio', 'voice', 'document', 'sticker']);
    expect(CONTACT_SOURCE_TYPES).toContain('whatsapp');
    expect(DND_SOURCES).toContain('whatsapp');
    expect(EMPTY_CONTACT_WHATSAPP).toEqual({
      waId: null,
      profileName: null,
      lastInboundAt: null,
      blocked: false,
      syncRemovedAt: null,
      nameEditedAt: null,
      keywordAt: null,
    });
    expect(INBOX_NOTIFY_MODES).toEqual(['assigned_or_all', 'assigned_only', 'off']);
    // owner decisions 23 Oct 2026
    expect(DEFAULT_INBOX_SETTINGS.sendReadReceipts).toBe(true);
    expect(DEFAULT_INBOX_SETTINGS.optOutReply).toBe(true);
    expect(DEFAULT_INBOX_SETTINGS.optInReply).toBe(true);
    expect(DEFAULT_INBOX_SETTINGS.optOutKeywords).toEqual(
      expect.arrayContaining(['STOP', 'UNSUBSCRIBE', 'BAND KARO', 'MAT BHEJO', 'बंद करो']),
    );
    expect(DEFAULT_INBOX_SETTINGS.optInKeywords).toEqual(
      expect.arrayContaining(['START', 'SHURU', 'चालू करो']),
    );
    const all = [...DEFAULT_INBOX_SETTINGS.optOutKeywords, ...DEFAULT_INBOX_SETTINGS.optInKeywords];
    expect(new Set(all).size).toBe(all.length);
    for (const k of all) {
      expect(k).toBe(k.normalize('NFC').toUpperCase());
      expect(k.length).toBeLessThanOrEqual(INBOX_LIMITS.keywordMaxLength);
    }
    expect(all.length).toBeLessThanOrEqual(INBOX_LIMITS.optOutKeywordsMax * 2);
    expect(DEFAULT_INBOX_SETTINGS.optOutReplyText).toContain('START');
    expect(DEFAULT_INBOX_SETTINGS.optOutReplyText.length).toBeLessThanOrEqual(
      INBOX_LIMITS.replyTextMax,
    );
    expect(INBOX_LIMITS).toMatchObject({
      textMax: 4096,
      captionMax: 1024,
      imageMaxBytes: 5 * 1024 * 1024,
      videoMaxBytes: 16 * 1024 * 1024,
      audioMaxBytes: 16 * 1024 * 1024,
      stickerMaxBytes: 100 * 1024,
      documentMaxBytes: 100 * 1024 * 1024,
      buttonsMax: 3,
      buttonTitleMax: 20,
      listRowsMax: 10,
      rowTitleMax: 24,
      rowDescriptionMax: 72,
      windowMs: 24 * 3_600_000,
      voiceNoteMaxSeconds: 600,
      inboundMediaValidMs: 7 * 24 * 3_600_000,
    });
    expect(META_MEDIA_HOST_SUFFIXES).toEqual([
      '.fbsbx.com',
      '.fbcdn.net',
      '.whatsapp.net',
      '.facebook.com',
    ]);
  });
});
