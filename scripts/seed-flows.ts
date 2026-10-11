/**
 * Demo call flows (`db:seed`): "Loan recovery" (published v1, AI node →
 * "Recovery Bot (Hinglish)") and "Customer feedback" (draft), plus the
 * "Welcome tone" audio. Idempotent: existing names are kept.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Types } from 'mongoose';

import type { Env } from '../src/config/env';
import { probeAudio } from '../src/core/engine/audio-probe';
import { graphChecksum } from '../src/core/engine/canonical';
import { storageKey, type StorageProvider } from '../src/core/storage';
import { AiAgentModel } from '../src/db/models/ai-agent.model';
import { CustomFieldModel } from '../src/db/models/custom-field.model';
import { FlowAudioModel } from '../src/db/models/flow-audio.model';
import { FlowVersionModel } from '../src/db/models/flow-version.model';
import { FlowModel } from '../src/db/models/flow.model';
import { graphStats, templateGraph } from '../src/modules/flows/flows.service';

export const SEED_FLOW_NAMES = { loan: 'Loan recovery', feedback: 'Customer feedback' } as const;
export const SEED_AUDIO_NAME = 'Welcome tone';
const WELCOME = path.resolve(__dirname, '../docs/samples/audio/welcome.wav');

export interface FlowSeedResult {
  flows: number;
  audio: boolean;
  /** Contact fields the Loan recovery template turned into flow variables. */
  addedVariables: string[];
}

export const seedFlows = async (
  accountId: Types.ObjectId,
  deps: {
    env: Pick<Env, 'APP_URL' | 'MOCK_APIS_ENABLED'>;
    ownerId: Types.ObjectId;
    storage: StorageProvider;
  },
): Promise<FlowSeedResult> => {
  let audio = false;
  if (!(await FlowAudioModel.exists({ accountId, name: SEED_AUDIO_NAME }))) {
    const buffer = readFileSync(WELCOME);
    const probe = probeAudio(buffer);
    if (!probe) throw new Error('welcome.wav is not a valid WAV — run npm run fixtures:audio');
    const _id = new Types.ObjectId();
    const key = storageKey({
      accountId: accountId.toString(),
      area: 'flow-audio',
      id: _id.toString(),
      ext: 'wav',
    });
    await deps.storage.put(key, buffer, { contentType: 'audio/wav' });
    await FlowAudioModel.create({
      _id,
      accountId,
      name: SEED_AUDIO_NAME,
      fileKey: key,
      format: probe.format,
      bytes: buffer.length,
      durationMs: probe.durationMs,
      sampleRate: probe.sampleRate,
      channels: probe.channels,
      uploadedBy: deps.ownerId,
    });
    audio = true;
  }

  let flows = 0;
  let addedVariables: string[] = [];
  if (!(await FlowModel.exists({ accountId, name: SEED_FLOW_NAMES.loan }))) {
    const agent = await AiAgentModel.findOne({ accountId, name: 'Recovery Bot (Hinglish)' })
      .select({ _id: 1 })
      .lean<{ _id: Types.ObjectId }>();
    const built = await templateGraph(
      accountId,
      'loan_recovery',
      agent ? { ai: agent._id.toString() } : {},
      deps,
    );
    let graph = built.graph;
    addedVariables = built.addedVariables;
    // the demo account stores the EMI as `emi_amount` (Phase 3 seed)
    if (
      addedVariables.includes('amount') &&
      (await CustomFieldModel.exists({ accountId, key: 'emi_amount' }))
    ) {
      graph = {
        ...graph,
        variables: graph.variables.filter((v) => v.name !== 'amount'),
        nodes: graph.nodes.map((n) =>
          n.id === 'greet'
            ? {
                ...n,
                config: {
                  ...n.config,
                  text: String(n.config.text).replace('{{amount}}', '{{emi_amount}}'),
                },
              }
            : n,
        ),
      };
      addedVariables = addedVariables.filter((v) => v !== 'amount');
    }
    const plain = graph as unknown as Record<string, unknown>;
    const checksum = graphChecksum(plain);
    const stats = graphStats(graph);
    const flow = await FlowModel.create({
      accountId,
      name: SEED_FLOW_NAMES.loan,
      description: 'Demo: keypad menu, payment check, AI agent, SMS link',
      draft: plain,
      draftChecksum: checksum,
      templateKey: 'loan_recovery',
      stats,
      createdBy: deps.ownerId,
      updatedBy: deps.ownerId,
    });
    if (agent) {
      const version = await FlowVersionModel.create({
        accountId,
        flowId: flow._id,
        version: 1,
        graph: plain,
        checksum,
        notes: 'Seeded',
        agentIds: stats.agents,
        audioIds: stats.audios,
        publishedBy: deps.ownerId,
        publishedAt: new Date(),
      });
      await FlowModel.updateOne(
        { _id: flow._id },
        {
          $set: {
            status: 'published',
            publishedVersionId: version._id,
            publishedVersion: 1,
            hasUnpublishedChanges: false,
          },
        },
      );
    }
    flows += 1;
  }
  if (!(await FlowModel.exists({ accountId, name: SEED_FLOW_NAMES.feedback }))) {
    const { graph } = await templateGraph(accountId, 'feedback_survey', {}, deps);
    const plain = graph as unknown as Record<string, unknown>;
    await FlowModel.create({
      accountId,
      name: SEED_FLOW_NAMES.feedback,
      description: 'Demo: 1–5 rating, low ratings asked why',
      draft: plain,
      draftChecksum: graphChecksum(plain),
      templateKey: 'feedback_survey',
      stats: graphStats(graph),
      createdBy: deps.ownerId,
      updatedBy: deps.ownerId,
    });
    flows += 1;
  }
  return { flows, audio, addedVariables };
};
