import type { Job, Queue } from 'bullmq';
import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import {
  AI_JOB_NAMES,
  AI_SCHEDULES,
  isAiJobName,
  queueAiJobs,
  unavailableAiJobs,
} from '../../src/core/ai/jobs';
import {
  AI_JOB_HANDLERS,
  processAiJob,
  type AiJobContext,
} from '../../src/core/queues/workers/ai.worker';
import { AgentPlaygroundSessionModel } from '../../src/db/models/agent-playground-session.model';
import { AiAgentModel } from '../../src/db/models/ai-agent.model';
import {
  isAgentInUse,
  purgeDeletedAgents,
  purgePlaygroundSessions,
} from '../../src/modules/ai-agents/maintenance';
import { createLogger } from '../../src/shared/logger';
import { useTestDb } from '../helpers/db';

useTestDb();

const ctx: AiJobContext = {
  jobs: unavailableAiJobs,
  logger: createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
};
const job = (name: string, data: unknown = {}) => ({ name, data }) as Job;
const DAY = 24 * 60 * 60 * 1000;

describe('ai worker', () => {
  it('dispatches by name and refuses unknown or unregistered jobs', async () => {
    const handler = vi.fn().mockResolvedValue({ deleted: 1 });
    await expect(
      processAiJob(ctx, { 'playground.purge': handler })(job('playground.purge')),
    ).resolves.toEqual({ deleted: 1 });
    expect(handler).toHaveBeenCalledWith({}, ctx, expect.anything());
    await expect(processAiJob(ctx, {})(job('kb.ingest'))).rejects.toThrow(
      'Unknown AI job "kb.ingest"',
    );
    await expect(processAiJob(ctx)(job('nope'))).rejects.toThrow('Unknown AI job');
    expect(Object.keys(AI_JOB_HANDLERS).sort()).toEqual([
      'agents.purge_deleted',
      'playground.purge',
    ]);
  });

  it('runs the registered purge handlers', async () => {
    await expect(processAiJob(ctx)(job('playground.purge'))).resolves.toEqual({ deleted: 0 });
    await expect(processAiJob(ctx)(job('agents.purge_deleted'))).resolves.toEqual({ purged: 0 });
  });

  it('knows its job names and UTC schedules', () => {
    expect(AI_JOB_NAMES).toContain('kb.ingest');
    expect(isAiJobName('email.send')).toBe(false);
    expect(AI_SCHEDULES.map((s) => s.name)).toEqual(['playground.purge', 'agents.purge_deleted']);
  });

  it('adds jobs with retry options and refuses without a queue', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    await queueAiJobs({ add } as unknown as Queue).enqueue('kb.reindex', {
      accountId: 'a',
      kbId: 'k',
    });
    expect(add).toHaveBeenCalledWith(
      'kb.reindex',
      { accountId: 'a', kbId: 'k' },
      expect.objectContaining({ attempts: 3 }),
    );
    await expect(unavailableAiJobs.enqueue('playground.purge', {})).rejects.toThrow(
      'not configured',
    );
  });
});

describe('AI maintenance jobs', () => {
  it('purges expired playground sessions only', async () => {
    const base = {
      accountId: new Types.ObjectId(),
      agentId: new Types.ObjectId(),
      userId: new Types.ObjectId(),
    };
    await AgentPlaygroundSessionModel.create([
      { ...base, expiresAt: new Date(Date.now() - 1000) },
      { ...base, expiresAt: new Date(Date.now() + DAY) },
    ]);
    expect(await purgePlaygroundSessions()).toEqual({ deleted: 1 });
    expect(await AgentPlaygroundSessionModel.countDocuments()).toBe(1);
  });

  it('hard-deletes agents soft-deleted more than 30 days ago', async () => {
    const accountId = new Types.ObjectId();
    const mk = (name: string, deletedAt: Date | null) =>
      AiAgentModel.create({ accountId, name, model: { textModel: 'gpt-4.1-mini' }, deletedAt });
    await mk('Old', new Date(Date.now() - 31 * DAY));
    await mk('Recent', new Date(Date.now() - 2 * DAY));
    await mk('Live', null);
    expect(await purgeDeletedAgents()).toEqual({ purged: 1 });
    const left = await AiAgentModel.find({ accountId }).setOptions({ withDeleted: true }).lean();
    expect(left.map((a) => a.name).sort()).toEqual(['Live', 'Recent']);
    await expect(isAgentInUse('x')).resolves.toBe(false);
  });
});
