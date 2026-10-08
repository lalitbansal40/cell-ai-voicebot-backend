import type { Schema } from 'mongoose';

const transform = (_doc: unknown, ret: Record<string, unknown>): Record<string, unknown> => {
  if (ret._id !== undefined) ret.id = (ret._id as { toString(): string }).toString();
  delete ret._id;
  delete ret.__v;
  return ret;
};

/** Timestamps + API-friendly JSON (`id` string, no `_id` / `__v`) — docs/conventions/data.md. */
export const basePlugin = (schema: Schema): void => {
  schema.set('timestamps', true);
  schema.set('toJSON', { virtuals: false, transform });
  schema.set('toObject', { virtuals: false, transform });
};
