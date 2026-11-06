import type { Collection, Document } from 'mongodb';

import { AccountModel } from '../../db/models/account.model';
import { AiAgentModel } from '../../db/models/ai-agent.model';
import { ContactModel } from '../../db/models/contact.model';
import { FlowVersionModel } from '../../db/models/flow-version.model';
import { FlowModel } from '../../db/models/flow.model';
import { MetaWebhookEventModel } from '../../db/models/meta-webhook-event.model';
import { UserModel } from '../../db/models/user.model';
import { WebhookEndpointModel } from '../../db/models/webhook-endpoint.model';
import { WhatsAppChannelModel } from '../../db/models/whatsapp-channel.model';

/**
 * Every field holding a value sealed with the secret box. `keys:reseal` works from this list,
 * and a test fails when a model gains a `*Sealed` / `sealed` field that isn't here.
 * `path` uses `*` for "each item of this array" and `%` for "each key of this object".
 */
export interface SealedField {
  name: string;
  collection: () => Collection<Document>;
  path: string;
}

const raw = (model: { collection: unknown }) => () => model.collection as Collection<Document>;

const flowHeaders = 'nodes.*.config.headers.*.sealed';

export const SEALED_FIELDS: SealedField[] = [
  {
    // the account's own Cell24x7 Voice API token
    name: 'accounts.voiceApi.credentials.tokenSealed',
    collection: raw(AccountModel),
    path: 'voiceApi.credentials.tokenSealed',
  },
  {
    name: 'whatsappChannels.tokenSealed',
    collection: raw(WhatsAppChannelModel),
    path: 'tokenSealed',
  },
  {
    name: 'whatsappChannels.registration.pinSealed',
    collection: raw(WhatsAppChannelModel),
    path: 'registration.pinSealed',
  },
  {
    name: 'metaWebhookEvents.payloadSealed',
    collection: raw(MetaWebhookEventModel),
    path: 'payloadSealed',
  },
  {
    name: 'webhookEndpoints.secretSealed',
    collection: raw(WebhookEndpointModel),
    path: 'secretSealed',
  },
  {
    name: 'webhookEndpoints.secretPreviousSealed',
    collection: raw(WebhookEndpointModel),
    path: 'secretPreviousSealed',
  },
  {
    name: 'aiAgents.functions.headers.sealed',
    collection: raw(AiAgentModel),
    path: 'functions.*.headers.*.sealed',
  },
  { name: 'flows.draft.headers.sealed', collection: raw(FlowModel), path: `draft.${flowHeaders}` },
  {
    name: 'flowVersions.graph.headers.sealed',
    collection: raw(FlowVersionModel),
    path: `graph.${flowHeaders}`,
  },
  { name: 'users.mfa.secretSealed', collection: raw(UserModel), path: 'mfa.secretSealed' },
  { name: 'contacts.variables.$enc', collection: raw(ContactModel), path: 'variables.%.$enc' },
];

export interface SealedValue {
  /** The exact dotted path in this document, e.g. `functions.2.headers.0.sealed`. */
  path: string;
  value: string;
}

/** Reads every sealed string a document holds at a `*` path. Empty values are skipped. */
export const readSealedValues = (doc: unknown, pattern: string): SealedValue[] => {
  const walk = (node: unknown, parts: string[], at: string[]): SealedValue[] => {
    const [head, ...rest] = parts;
    if (head === undefined) {
      return typeof node === 'string' && node !== '' ? [{ path: at.join('.'), value: node }] : [];
    }
    if (node === null || typeof node !== 'object') return [];
    if (head === '%') {
      return Object.entries(node as Record<string, unknown>).flatMap(([key, item]) =>
        walk(item, rest, [...at, key]),
      );
    }
    if (head === '*') {
      if (!Array.isArray(node)) return [];
      return node.flatMap((item, i) => walk(item, rest, [...at, String(i)]));
    }
    return walk((node as Record<string, unknown>)[head], rest, [...at, head]);
  };
  return walk(doc, pattern.split('.'), []);
};

/** The field to project and to page by: everything before the first `*`. */
export const projectionRoot = (pattern: string): string => pattern.split(/\.[*%]/)[0] ?? pattern;
