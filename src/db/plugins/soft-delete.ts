import type { Aggregate, Model, Query, Schema } from 'mongoose';

export interface SoftDeleteDoc {
  deletedAt: Date | null;
  softDelete(): Promise<unknown>;
}

const FILTERED_QUERIES = [
  'find',
  'findOne',
  'countDocuments',
  'findOneAndUpdate',
  'updateMany',
  'updateOne',
] as const;

/**
 * Soft delete (data.md §4): `deletedAt` + automatic `deletedAt: null` filter.
 * Opt out per query with `{ withDeleted: true }` in the query options.
 */
export const softDeletePlugin = (schema: Schema): void => {
  schema.add({ deletedAt: { type: Date, default: null, index: true } });

  for (const op of FILTERED_QUERIES) {
    schema.pre(op, function (this: Query<unknown, unknown>) {
      const options = this.getOptions() as { withDeleted?: boolean };
      if (!options.withDeleted && this.getFilter().deletedAt === undefined) {
        this.where({ deletedAt: null });
      }
    });
  }

  schema.pre('aggregate', function (this: Aggregate<unknown>) {
    const options = this.options as { withDeleted?: boolean };
    if (!options.withDeleted) this.pipeline().unshift({ $match: { deletedAt: null } });
  });

  schema.method(
    'softDelete',
    function (this: { deletedAt: Date | null; save(): Promise<unknown> }) {
      this.deletedAt = new Date();
      return this.save();
    },
  );

  // The filter mentions `deletedAt` explicitly, so the auto-filter hook leaves it alone.
  schema.static('restore', function (this: Model<unknown>, id: unknown) {
    return this.updateOne({ _id: id, deletedAt: { $ne: null } }, { $set: { deletedAt: null } });
  });
};
