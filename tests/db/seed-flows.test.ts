import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { SEED_AUDIO_NAME, SEED_FLOW_NAMES, seedFlows } from '../../scripts/seed-flows';
import { FlowGraphSchema } from '../../src/core/engine/schema';
import { validateFlow } from '../../src/core/engine/validate';
import { AiAgentModel } from '../../src/db/models/ai-agent.model';
import { CustomFieldModel } from '../../src/db/models/custom-field.model';
import { FlowAudioModel } from '../../src/db/models/flow-audio.model';
import { FlowVersionModel } from '../../src/db/models/flow-version.model';
import { FlowModel } from '../../src/db/models/flow.model';
import { useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';

useTestDb();
const storage = useTempStorage();
const env = { APP_URL: 'http://localhost:5100', MOCK_APIS_ENABLED: true };

describe('seedFlows', () => {
  it('seeds the published Loan recovery, the draft survey and the welcome audio once', async () => {
    const accountId = new Types.ObjectId();
    const agent = await AiAgentModel.create({
      accountId,
      name: 'Recovery Bot (Hinglish)',
      model: { textModel: 'gpt-4.1-mini' },
    });
    await CustomFieldModel.create({
      accountId,
      key: 'emi_amount',
      label: 'EMI amount',
      type: 'currency',
    });
    await CustomFieldModel.create({ accountId, key: 'due_date', label: 'Due date', type: 'date' });
    const deps = { env, ownerId: new Types.ObjectId(), storage };
    const first = await seedFlows(accountId, deps);
    expect(first).toEqual({ flows: 2, audio: true, addedVariables: ['loan_id'] });
    const loan = await FlowModel.findOne({ accountId, name: SEED_FLOW_NAMES.loan }).lean();
    expect(loan).toMatchObject({
      status: 'published',
      publishedVersion: 1,
      hasUnpublishedChanges: false,
    });
    const graph = FlowGraphSchema.parse(loan?.draft);
    expect(graph.nodes.find((n) => n.id === 'greet')?.config.text).toContain('{{emi_amount}}');
    expect(graph.variables.map((v) => v.name)).toEqual(['loan_id', 'payment_status']);
    const issues = validateFlow(graph, {
      contactVars: [
        { name: 'name', label: 'Name', type: 'built_in' },
        { name: 'emi_amount', label: 'EMI', type: 'currency' },
        { name: 'due_date', label: 'Due', type: 'date' },
      ],
      agents: new Map([[agent._id.toString(), { active: true }]]),
      audios: new Set(),
      urlPolicy: { httpsOnly: false, allowPrivate: true, extraPorts: [5100] },
    });
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(await FlowVersionModel.countDocuments({ flowId: loan?._id })).toBe(1);
    expect(
      (await FlowModel.findOne({ accountId, name: SEED_FLOW_NAMES.feedback }).lean())?.status,
    ).toBe('draft');
    const audio = await FlowAudioModel.findOne({ accountId, name: SEED_AUDIO_NAME }).lean();
    expect(audio).toMatchObject({ format: 'wav', durationMs: 2000, sampleRate: 8000 });
    expect(await storage.exists(audio!.fileKey)).toBe(true);
    expect(await seedFlows(accountId, deps)).toEqual({
      flows: 0,
      audio: false,
      addedVariables: [],
    });
  });

  it('without the recovery agent the flow stays a draft (AI node to configure)', async () => {
    const accountId = new Types.ObjectId();
    const result = await seedFlows(accountId, { env, ownerId: new Types.ObjectId(), storage });
    expect(result.addedVariables).toEqual(['amount', 'due_date', 'loan_id']);
    const loan = await FlowModel.findOne({ accountId, name: SEED_FLOW_NAMES.loan }).lean();
    expect(loan?.status).toBe('draft');
  });
});
