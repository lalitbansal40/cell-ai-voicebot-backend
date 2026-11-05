import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Redis } from 'ioredis';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createFakeProvider } from '../../src/core/ai';
import { CallModel } from '../../src/db/models/call.model';
import { CampaignContactModel } from '../../src/db/models/campaign-contact.model';
import { CampaignModel } from '../../src/db/models/campaign.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { WhatsAppCallPermissionModel } from '../../src/db/models/whatsapp-call-permission.model';
import { WhatsAppChannelModel, defaultCalling } from '../../src/db/models/whatsapp-channel.model';
import { WhatsAppTemplateModel } from '../../src/db/models/whatsapp-template.model';
import {
  createCampaign,
  setCampaignHooks,
  startCampaign,
} from '../../src/modules/campaigns/campaigns.service';
import { onCampaignCallPermission } from '../../src/modules/campaigns/permission-events';
import { allowedCallContacts } from '../../src/modules/campaigns/whatsapp-line';
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
