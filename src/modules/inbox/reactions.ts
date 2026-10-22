import type { Types } from 'mongoose';

import { MessageModel, type MessageDoc } from '../../db/models/message.model';

import { emitMessageUpdated } from './events';

/** A reaction replaces the actor's earlier one on the target (`''` removes it). */
export const applyReaction = async (
  target: MessageDoc,
  by: 'customer' | 'agent',
  emoji: string,
  at: Date,
  userId: Types.ObjectId | null = null,
): Promise<MessageDoc | null> => {
  const pull = by === 'customer' ? { by: 'customer' } : { by: 'agent', userId };
  await MessageModel.updateOne({ _id: target._id }, { $pull: { reactions: pull } });
  const updated = emoji
    ? await MessageModel.findOneAndUpdate(
        { _id: target._id },
        { $push: { reactions: { emoji, by, userId, at } } },
        { returnDocument: 'after' },
      ).lean<MessageDoc>()
    : await MessageModel.findById(target._id).lean<MessageDoc>();
  if (updated) emitMessageUpdated(updated);
  return updated;
};
