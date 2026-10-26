import { describe, expect, it, vi } from 'vitest';

import { ConversationModel } from '../../src/db/models/conversation.model';
import { setConversationStatus } from '../../src/modules/inbox/conversations.service';
import { useTestDb } from '../helpers/db';
import { customerText, useInboxWorld } from '../helpers/inbox';

useTestDb();
const world = useInboxWorld();
const { state } = world;

describe('inbox close → chat summary hook (Phase 14)', () => {
  it('runs once when a conversation is closed, not on reopen or a no-op close', async () => {
    const { users } = await world.setup();
    expect(await world.deliver(customerText(state.channel, { text: 'hello' }))).toEqual([
      'processed',
    ]);
    const conv = await ConversationModel.findOne({ accountId: state.acc.account._id }).lean();
    const onClosed = vi.fn((_c: unknown) => Promise.resolve());
    const ix = { ...state.ix, summaries: { onClosed } };
    const actor = {
      type: 'user' as const,
      id: users.owner.user._id,
      accountId: state.acc.account._id,
      userId: users.owner.user._id,
    };
    const id = conv?._id.toString() ?? '';
    await setConversationStatus(ix, actor, id, 'closed');
    await setConversationStatus(ix, actor, id, 'closed');
    await setConversationStatus(ix, actor, id, 'open');
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(onClosed.mock.calls[0]?.[0]).toMatchObject({ _id: conv?._id, status: 'closed' });
    // without the hook nothing breaks
    await setConversationStatus(state.ix, actor, id, 'closed');
  });
});
