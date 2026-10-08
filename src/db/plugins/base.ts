import type { Schema } from 'mongoose';

export interface BasePluginOptions {
  /** Fields never serialised (secrets: password / token hashes). */
  hide?: readonly string[];
}

/** Timestamps + API-friendly JSON (`id` string, no `_id` / `__v`) — docs/conventions/data.md. */
export const basePlugin = (schema: Schema, options: BasePluginOptions = {}): void => {
  const hide = options.hide ?? [];
  const transform = (_doc: unknown, ret: Record<string, unknown>): Record<string, unknown> => {
    if (ret._id !== undefined) ret.id = (ret._id as { toString(): string }).toString();
    delete ret._id;
    delete ret.__v;
    for (const field of hide) delete ret[field];
    return ret;
  };
  schema.set('timestamps', true);
  schema.set('toJSON', { virtuals: false, transform });
  schema.set('toObject', { virtuals: false, transform });
};
