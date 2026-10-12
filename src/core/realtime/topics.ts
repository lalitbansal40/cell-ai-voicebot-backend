export type TopicKind = 'call' | 'campaign';

export interface ParsedTopic {
  kind: TopicKind;
  id: string;
}

const TOPIC = /^(call|campaign):([a-f0-9]{24})$/i;

/** `campaign:<objectId>` → `{ kind, id }`; anything else → undefined. */
export const parseTopic = (topic: string): ParsedTopic | undefined => {
  const match = TOPIC.exec(topic);
  return match
    ? { kind: match[1]?.toLowerCase() as TopicKind, id: (match[2] as string).toLowerCase() }
    : undefined;
};

export interface TopicContext {
  accountId: string;
  userId: string;
}

export type AuthorizeTopic = (ctx: TopicContext, topic: ParsedTopic) => boolean | Promise<boolean>;

/**
 * Format check only — for tests and tools. The server passes the real check
 * (`modules/calls/topic-auth.ts`: the call belongs to the account and the role has `calls.read`).
 */
export const defaultAuthorizeTopic: AuthorizeTopic = () => true;
