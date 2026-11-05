import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createFakeProvider } from '../../src/core/ai';
import { AiAgentModel } from '../../src/db/models/ai-agent.model';
import { CallModel } from '../../src/db/models/call.model';
import { CampaignContactModel } from '../../src/db/models/campaign-contact.model';
import { CampaignModel } from '../../src/db/models/campaign.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { FlowModel } from '../../src/db/models/flow.model';
import { WhatsAppCallPermissionModel } from '../../src/db/models/whatsapp-call-permission.model';
import { WhatsAppChannelModel, defaultCalling } from '../../src/db/models/whatsapp-channel.model';
import { WhatsAppTemplateModel } from '../../src/db/models/whatsapp-template.model';
import type { CallEndedSummary } from '../../src/modules/calls/session';
import {
  createCampaign,
  setCampaignHooks,
  startCampaign,
  estimateCampaignCost,
} from '../../src/modules/campaigns/campaigns.service';
import type { DispatcherDeps } from '../../src/modules/campaigns/dispatcher';
import { queueCampaignExports, wireCampaigns } from '../../src/modules/campaigns/jobs';
import { onCampaignCallPermission } from '../../src/modules/campaigns/permission-events';
import { allowedCallContacts } from '../../src/modules/campaigns/whatsapp-line';
import type { CallingRuntime } from '../../src/modules/whatsapp-calling/runtime';
import { createLogger } from '../../src/shared/logger';
import { ensureRateCard } from '../helpers/calls';
import { campaignWorld, type CampaignWorld } from '../helpers/campaigns';
import { useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const storage = useTempStorage();
const ports: number[] = [];
const app = buildTestApp(
  {},
  {
    storage,
    aiProvider: createFakeProvider(),
    aiHttp: { extraPorts: ports, resolve: () => Promise.resolve(['127.0.0.1']) },
  },
);
const directory = mkdtempSync(join(tmpdir(), 'cav-wa-campaign-'));
const prefix = uniquePrefix('wa-campaign');
let server: Server;
let redis: Redis;
let world: CampaignWorld;
let channelId: string;
let liveEnded: ((summary: CallEndedSummary) => Promise<void>) | undefined;
const startLive = vi.fn<NonNullable<DispatcherDeps['whatsappCalls']>['startOutbound']>(
  async (actor, input) => {
    const call = await CallModel.create({
      accountId: actor.accountId,
      provider: 'whatsapp',
      direction: 'outbound',
      mode: 'ai',
      from: 'whatsapp',
      to: (await ContactModel.findById(input.contactId).lean())!.phoneE164,
      contactId: input.contactId,
      ...input.campaign,
      status: 'completed',
      endReason: 'customer_hangup',
      source:
        input.program?.kind === 'agent'
          ? { kind: 'agent', agentId: new Types.ObjectId(input.program.id) }
          : {
              kind: 'flow',
              flowId: input.program?.id ? new Types.ObjectId(input.program.id) : undefined,
              flowVersionRef: input.campaign?.flowVersion ?? undefined,
            },
      billing: {
        whatsapp: { status: 'released', payer: 'customer', market: 'IN', perMinuteMicros: 0 },
      },
      timestamps: { queuedAt: new Date(), answeredAt: new Date(), endedAt: new Date() },
    });
    return { callId: call._id.toString() };
  },
);
beforeAll(async () => {
  server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  ports.push(port);
  redis = (await requireRedis()).client;
  await ensureRateCard();
  world = await campaignWorld(
    {
      app,
      port,
      redis,
      prefix,
      storage,
      recordingDir: directory,
      logger: createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
      phonePrefix: '90081',
      whatsappCalls: {
        startOutbound: startLive,
        onCallEnded: (fn) => {
          liveEnded = fn;
          return () => false;
        },
        hangupCampaign: () => Promise.resolve(0),
      },
    },
    { maxConcurrentCalls: 20, manualTicks: true },
  );
  const calling = defaultCalling();
  calling.status = 'enabled';
  channelId = (
    await WhatsAppChannelModel.create({
      accountId: world.t.account._id,
      label: 'Campaign sender',
      provider: 'fake',
      mode: 'cloud_api',
      status: 'connected',
      wabaId: `fake-${world.accountId}`,
      metaPayer: 'platform',
      calling,
    })
  )._id.toString();
});
afterAll(async () => {
  setCampaignHooks({});
  await world?.shutdown();
  await flushPrefix(redis, prefix);
  redis?.disconnect();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
});

describe('WhatsApp call campaigns', () => {
  it('stores an AI agent without inventing a flow ID and rejects a foreign/not-ready number', async () => {
    const id = await world.campaign({
      line: 'whatsapp',
      channelId,
      flowId: undefined,
      program: { kind: 'agent', id: world.agentId },
    });
    const doc = await world.docOf(id);
    expect(doc.flowId).toBeNull();
    expect(doc.program?.id.toString()).toBe(world.agentId);
    await expect(
      world.campaign({
        line: 'whatsapp',
        channelId: new Types.ObjectId().toString(),
        program: { kind: 'agent', id: world.agentId },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      createCampaign(world.req, { name: 'No SIP program', mode: 'dry_run' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
  it('permission is per sender, expires, and snapshot skips unapproved contacts', async () => {
    const listId = await world.listOf(3);
    const contacts = await ContactModel.find({ listIds: listId }).lean();
    await WhatsAppCallPermissionModel.create({
      accountId: world.t.account._id,
      channelId,
      contactId: contacts[0]!._id,
      status: 'permanent',
    });
    await WhatsAppCallPermissionModel.create({
      accountId: world.t.account._id,
      channelId,
      contactId: contacts[1]!._id,
      status: 'temporary',
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(
      (
        await allowedCallContacts(
          world.t.account._id,
          new Types.ObjectId(channelId),
          contacts.map((c) => c._id),
        )
      ).size,
    ).toBe(1);
    expect(
      (
        await allowedCallContacts(
          world.t.account._id,
          new Types.ObjectId(),
          contacts.map((c) => c._id),
        )
      ).size,
    ).toBe(0);
    const id = await world.campaign({
      line: 'whatsapp',
      channelId,
      audience: { listIds: [listId], excludeActiveCampaigns: false },
    });
    await startCampaign(world.req, id);
    expect((await world.docOf(id)).stats.skippedBy.no_call_permission).toBe(2);
    await CampaignModel.updateOne({ _id: id }, { $set: { status: 'canceled' } });
  });
  it('a permission grant wakes an existing ask-first row once, never another sender or a stopped campaign', async () => {
    const listId = await world.listOf(1);
    const contact = await ContactModel.findOne({ listIds: listId }).lean();
    const template = await WhatsAppTemplateModel.create({
      accountId: world.t.account._id,
      wabaId: `fake-${world.accountId}`,
      name: 'permission',
      language: 'en',
      category: 'UTILITY',
      purpose: 'call_permission',
      status: 'APPROVED',
    });
    const id = await world.campaign({
      line: 'whatsapp',
      channelId,
      askPermissionFirst: { templateId: template._id.toString() },
      audience: { listIds: [listId], excludeActiveCampaigns: false },
    });
    await startCampaign(world.req, id);
    world.clock.advance(Math.max(0, Date.now() - world.clock.now()) + 1000);
    await world.dispatcher.tick(world.accountId);
    expect((await CampaignContactModel.findOne({ campaignId: id }).lean())?.status).toBe(
      'retry_wait',
    );
    await CampaignContactModel.updateOne(
      { campaignId: id },
      { $set: { status: 'retry_wait', nextAttemptAt: new Date(Date.now() + 60_000) } },
    );
    const permission = (
      await WhatsAppCallPermissionModel.create({
        accountId: world.t.account._id,
        channelId,
        contactId: contact!._id,
        status: 'permanent',
      })
    ).toObject();
    await onCampaignCallPermission(permission);
    await onCampaignCallPermission(permission);
    expect(await CampaignContactModel.countDocuments({ campaignId: id })).toBe(1);
    expect(
      (await CampaignContactModel.findOne({ campaignId: id }).lean())?.nextAttemptAt!.getTime(),
    ).toBeLessThanOrEqual(Date.now());
    await CampaignModel.updateOne({ _id: id }, { $set: { status: 'canceled' } });
    await CampaignContactModel.updateOne({ campaignId: id }, { $set: { nextAttemptAt: null } });
    await onCampaignCallPermission(permission);
    expect(
      (await CampaignContactModel.findOne({ campaignId: id }).lean())?.nextAttemptAt,
    ).toBeNull();
  });
  it('re-checks permission before dial and skips after two unanswered attempts', async () => {
    const listId = await world.listOf(2);
    const contacts = await ContactModel.find({ listIds: listId }).lean();
    await WhatsAppCallPermissionModel.insertMany(
      contacts.map((contact) => ({
        accountId: world.t.account._id,
        channelId,
        contactId: contact._id,
        status: 'permanent',
      })),
    );
    const id = await world.campaign({
      line: 'whatsapp',
      channelId,
      audience: { listIds: [listId], excludeActiveCampaigns: false },
    });
    await startCampaign(world.req, id);
    await WhatsAppCallPermissionModel.updateOne(
      { channelId, contactId: contacts[0]!._id },
      { $set: { status: 'revoked' } },
    );
    const recipient = await CampaignContactModel.findOne({
      campaignId: id,
      contactId: contacts[1]!._id,
    }).lean();
    await CallModel.insertMany(
      [1, 2].map((attempt) => ({
        accountId: world.t.account._id,
        direction: 'outbound',
        provider: 'dryrun',
        from: 'dryrun',
        to: contacts[1]!.phoneE164,
        contactId: contacts[1]!._id,
        campaignId: id,
        campaignContactId: recipient!._id,
        attempt,
        source: { kind: 'flow', flowId: world.flowId, flowVersionRef: 1 },
        timestamps: { queuedAt: new Date() },
        status: 'no_answer',
        endReason: 'no_answer',
      })),
    );
    world.clock.advance(Math.max(0, Date.now() - world.clock.now()) + 1000);
    await world.dispatcher.tick(world.accountId);
    const rows = await CampaignContactModel.find({ campaignId: id }).lean();
    expect(rows.map((row) => row.skipReason).sort()).toEqual([
      'no_call_permission',
      'unanswered_limit',
    ]);
    expect(await CallModel.countDocuments({ campaignId: id })).toBe(2);
  });

  it('starts an ask-first campaign through the bulk permission job hook', async () => {
    const listId = await world.listOf(2);
    const template = await WhatsAppTemplateModel.create({
      accountId: world.t.account._id,
      wabaId: `fake-${world.accountId}`,
      name: 'ask_first_job',
      language: 'en',
      category: 'UTILITY',
      purpose: 'call_permission',
      status: 'APPROVED',
    });
    const bulk = {
      start: vi.fn<CallingRuntime['bulk']['start']>(() =>
        Promise.resolve({ runId: new Types.ObjectId().toString() }),
      ),
    };
    const schedule = vi.fn(() => Promise.resolve());
    const unwire = wireCampaigns({
      jobs: {
        schedule,
        scheduleEnd: () => Promise.resolve(),
        drop: () => Promise.resolve(),
      },
      dispatcher: world.dispatcher,
      calls: world.calls,
      calling: { bulk } as unknown as CallingRuntime,
      logger: createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
    });
    const id = await world.campaign({
      line: 'whatsapp',
      channelId,
      askPermissionFirst: { templateId: template._id.toString() },
      audience: { listIds: [listId], excludeActiveCampaigns: false },
    });
    try {
      await startCampaign(world.req, id);
      expect(bulk.start).toHaveBeenCalledOnce();
      expect(bulk.start.mock.calls[0]?.[1]).toMatchObject({
        channelId,
        templateId: template._id.toString(),
        target: { contactIds: expect.any(Array) },
        runId: expect.stringMatching(/^[a-f0-9]{24}$/),
      });
      const scheduledId = await world.campaign({
        line: 'whatsapp',
        channelId,
        audience: { listIds: [listId], excludeActiveCampaigns: false },
        schedule: { startAt: new Date(Date.now() + 3_600_000).toISOString() },
      });
      await startCampaign(world.req, scheduledId);
      expect(schedule).toHaveBeenCalledOnce();
      expect((await world.docOf(scheduledId)).status).toBe('scheduled');
      await CampaignModel.updateOne({ _id: scheduledId }, { $set: { status: 'canceled' } });
    } finally {
      unwire();
      await CampaignModel.updateOne({ _id: id }, { $set: { status: 'canceled' } });
    }
  });

  it.each(['agent', 'flow'] as const)(
    'dispatches a live %s program through WhatsApp with stable campaign identity and one result',
    async (kind) => {
      startLive.mockClear();
      const listId = await world.listOf(1);
      const contact = await ContactModel.findOne({ listIds: listId }).lean();
      await WhatsAppCallPermissionModel.create({
        accountId: world.t.account._id,
        channelId,
        contactId: contact!._id,
        status: 'permanent',
      });
      const programId = kind === 'agent' ? world.agentId : world.flowId;
      const id = await world.campaign({
        mode: 'live',
        line: 'whatsapp',
        channelId,
        flowId: undefined,
        program: { kind, id: programId },
        audience: { listIds: [listId], excludeActiveCampaigns: false },
        retry: { maxAttempts: 1, intervalMinutes: 15, retryOn: [] },
        followUps: { callbacks: false, promiseCheck: { enabled: false, daysAfter: 1 } },
      });
      const estimate = await estimateCampaignCost(world.req, id);
      expect(estimate).toMatchObject({ contacts: 1 });
      expect(estimate.totalMicros).toBeGreaterThan(0);
      await startCampaign(world.req, id);
      const noon = new Date(world.clock.now() + 86_400_000);
      noon.setUTCHours(6, 30, 0, 0);
      world.clock.advance(noon.getTime() - world.clock.now());
      await world.dispatcher.tick(world.accountId);
      await world.dispatcher.tick(world.accountId);
      await expect(startLive.mock.results[0]?.value).resolves.toHaveProperty('callId');
      expect(startLive).toHaveBeenCalledOnce();
      const input = startLive.mock.calls[0]![1];
      expect(input).toMatchObject({
        channelId,
        contactId: contact!._id.toString(),
        mode: 'ai',
        program: { kind },
        campaign: { campaignId: id, attempt: 1 },
      });
      expect(String(input.program!.id)).toBe(programId);
      expect((await world.docOf(id)).stats.attempts).toBe(1);
      const recipient = await CampaignContactModel.findOne({ campaignId: id }).lean();
      expect(recipient?.status).toBe('completed');
      const call = await CallModel.findOne({ campaignId: id }).lean();
      await liveEnded!({
        callId: call!._id.toString(),
        accountId: world.accountId,
        status: 'completed',
        endReason: 'customer_hangup',
        durationSec: 1,
        costMicros: 0,
        disposition: null,
        outcome: {},
      });
      expect((await world.docOf(id)).stats.attempts).toBe(1);
      expect(await CallModel.countDocuments({ campaignId: id, provider: 'whatsapp' })).toBe(1);
    },
  );

  it.each(['agent', 'flow'] as const)(
    'pauses before dial when a saved %s becomes unavailable',
    async (kind) => {
      startLive.mockClear();
      const listId = await world.listOf(1);
      const contact = await ContactModel.findOne({ listIds: listId }).lean();
      await WhatsAppCallPermissionModel.create({
        accountId: world.t.account._id,
        channelId,
        contactId: contact!._id,
        status: 'permanent',
      });
      const id = await world.campaign({
        mode: 'live',
        line: 'whatsapp',
        channelId,
        flowId: undefined,
        program: { kind, id: kind === 'agent' ? world.agentId : world.flowId },
        audience: { listIds: [listId], excludeActiveCampaigns: false },
      });
      await startCampaign(world.req, id);
      if (kind === 'agent')
        await AiAgentModel.updateOne({ _id: world.agentId }, { $set: { isActive: false } });
      else await FlowModel.updateOne({ _id: world.flowId }, { $set: { status: 'archived' } });
      try {
        await world.dispatcher.tick(world.accountId);
        expect(startLive).not.toHaveBeenCalled();
        expect((await world.docOf(id)).status).toBe('paused');
      } finally {
        await AiAgentModel.updateOne({ _id: world.agentId }, { $set: { isActive: true } });
        await FlowModel.updateOne({ _id: world.flowId }, { $set: { status: 'published' } });
        await CampaignModel.updateOne({ _id: id }, { $set: { status: 'canceled' } });
      }
    },
  );

  it('pauses before dispatch when its selected WhatsApp number disconnects', async () => {
    const listId = await world.listOf(1);
    const contact = await ContactModel.findOne({ listIds: listId }).lean();
    await WhatsAppCallPermissionModel.create({
      accountId: world.t.account._id,
      channelId,
      contactId: contact!._id,
      status: 'permanent',
    });
    const id = await world.campaign({
      line: 'whatsapp',
      channelId,
      audience: { listIds: [listId], excludeActiveCampaigns: false },
    });
    await startCampaign(world.req, id);
    await WhatsAppChannelModel.updateOne({ _id: channelId }, { $set: { status: 'disconnected' } });
    try {
      await world.dispatcher.tick(world.accountId);
      expect((await world.docOf(id)).status).toBe('paused');
      expect(await CallModel.countDocuments({ campaignId: id })).toBe(0);
      expect((await CampaignContactModel.findOne({ campaignId: id }).lean())?.status).toBe(
        'pending',
      );
    } finally {
      await WhatsAppChannelModel.updateOne({ _id: channelId }, { $set: { status: 'connected' } });
      await CampaignModel.updateOne({ _id: id }, { $set: { status: 'canceled' } });
    }
  });

  it('queues results exports with stable job IDs and bounded retries', async () => {
    const add = vi.fn(() => Promise.resolve({}));
    const port = queueCampaignExports({ add } as unknown as Queue);
    const data = { accountId: world.accountId, exportJobId: new Types.ObjectId().toString() };
    await port.enqueue(data);
    await port.enqueue(data);
    expect(add).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenLastCalledWith(
      'campaign.export',
      data,
      expect.objectContaining({
        jobId: `export-${data.exportJobId}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      }),
    );
  });

  it('completes 100 allowed recipients on the dry-run line with one call per recipient', async () => {
    const listId = await world.listOf(100);
    const contacts = await ContactModel.find({ listIds: listId }).lean();
    await WhatsAppCallPermissionModel.insertMany(
      contacts.map((contact) => ({
        accountId: world.t.account._id,
        channelId,
        contactId: contact._id,
        status: 'permanent',
      })),
    );
    const id = await world.campaign({
      line: 'whatsapp',
      channelId,
      flowId: undefined,
      program: { kind: 'agent', id: world.agentId },
      audience: { listIds: [listId], excludeActiveCampaigns: false },
      retry: { maxAttempts: 1, intervalMinutes: 15, retryOn: [] },
      pacing: { concurrency: 20, dialsPerMinute: 60 },
      followUps: { callbacks: false, promiseCheck: { enabled: false, daysAfter: 1 } },
      dryRun: {
        scenarios: {
          paid: 100,
          promise: 0,
          refuse: 0,
          callback: 0,
          silence: 0,
          wrong_number: 0,
          hangup_early: 0,
          wrong_keys: 0,
        },
        speed: 20,
        mix: { answered: 10000, no_answer: 0, busy: 0, failed: 0, invalid_number: 0 },
      },
    });
    await startCampaign(world.req, id);
    const finished = await world.drive(async () => (await world.docOf(id)).status === 'completed', {
      rounds: 500,
      stepMs: 1000,
    });
    expect(finished).toBe(true);
    const calls = await CallModel.find({ campaignId: id }).lean();
    expect(calls).toHaveLength(100);
    expect(new Set(calls.map((c) => c.campaignContactId?.toString())).size).toBe(100);
    expect(
      calls.every(
        (c) =>
          c.source.kind === 'agent' && c.source.agentId?.toString() === world.agentId && !c.charged,
      ),
    ).toBe(true);
  });
});
