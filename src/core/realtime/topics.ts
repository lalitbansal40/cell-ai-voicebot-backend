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
 * Phase 1: format check only.
 * TODO(P7/P8): verify the call / campaign belongs to ctx.accountId before allowing the subscription.
 */
export const defaultAuthorizeTopic: AuthorizeTopic = () => true;
