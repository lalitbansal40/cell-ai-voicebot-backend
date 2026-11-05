import type { Types } from 'mongoose';

import { loadEnv } from '../../src/config/env';
import { createFakeProvider } from '../../src/core/ai';
import { graphChecksum } from '../../src/core/engine/canonical';
import { FlowGraphSchema } from '../../src/core/engine/schema';
import type { StorageProvider } from '../../src/core/storage';
import { FakeStt } from '../../src/core/voice/providers';
import type { CallDoc } from '../../src/db/models/call.model';
import { FlowVersionModel } from '../../src/db/models/flow-version.model';
import { FlowModel } from '../../src/db/models/flow.model';
import { flowScript } from '../../src/modules/calls/flow-script';

/** A real published flow run through the existing WhatsApp media/session runtime. */
export const publishedWhatsAppFlow = async (accountId: Types.ObjectId) => {
  const graph = FlowGraphSchema.parse({
    schemaVersion: 1,
    nodes: [
      {
        id: 'start',
        type: 'start',
        position: { x: 0, y: 0 },
        config: { triggers: ['inbound', 'campaign', 'api', 'test'] },
      },
      {
        id: 'result',
        type: 'set_disposition',
        position: { x: 0, y: 100 },
        config: { disposition: 'paid' },
      },
      { id: 'bye', type: 'hangup', position: { x: 0, y: 200 }, config: { text: 'Thank you.' } },
    ],
    edges: [
      { id: 'e1', source: 'start', sourceHandle: 'next', target: 'result' },
      { id: 'e2', source: 'result', sourceHandle: 'next', target: 'bye' },
    ],
  });
  const flow = await FlowModel.create({
    accountId,
    name: 'WhatsApp published result',
    status: 'published',
    draft: graph,
    publishedVersion: 1,
  });
  const version = await FlowVersionModel.create({
    accountId,
    flowId: flow._id,
    version: 1,
    graph,
    checksum: graphChecksum(graph),
    publishedAt: new Date(),
  });
  await FlowModel.updateOne({ _id: flow._id }, { $set: { publishedVersionId: version._id } });
  return flow._id.toString();
};

export const realWhatsAppFlowScript = (call: CallDoc, storage: StorageProvider) =>
  flowScript(call, {
    env: loadEnv({}),
    secretKey: Buffer.alloc(32, 1),
    provider: createFakeProvider(),
    stt: new FakeStt(),
    storage,
    runAi: () => Promise.reject(new Error('This published flow does not contain an AI node')),
  });
