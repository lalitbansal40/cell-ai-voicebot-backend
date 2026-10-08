import mongoose, { Schema, type Model, type Query, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

export type AuditActorType = 'user' | 'api_key' | 'system';

export interface AuditActor {
  type: AuditActorType;
  id?: Types.ObjectId | null;
  /** Superadmin acting on behalf of the user (impersonation). */
  impersonatorId?: Types.ObjectId | null;
  /** Action done by a platform superadmin (suspend / enable). */
  platform?: boolean;
}

export interface AuditLogDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  actor: AuditActor;
  action: string;
  target?: { type: string; id?: string | null } | null;
  meta?: Record<string, unknown> | null;
  ip?: string | null;
  at: Date;
}

const schema = new Schema<AuditLogDoc>(
  {
    actor: {
      type: new Schema<AuditActor>(
        {
          type: { type: String, enum: ['user', 'api_key', 'system'], required: true },
          id: { type: Schema.Types.ObjectId, default: null },
          impersonatorId: { type: Schema.Types.ObjectId, default: null },
          platform: { type: Boolean, default: false },
        },
        { _id: false },
      ),
      required: true,
    },
    action: { type: String, required: true, maxlength: 80 },
    target: {
      type: new Schema(
        { type: { type: String, required: true }, id: { type: String, default: null } },
        { _id: false },
      ),
      default: null,
    },
    meta: { type: Schema.Types.Mixed, default: null },
    ip: { type: String, default: null },
    at: { type: Date, required: true, default: () => new Date() },
  },
  { minimize: true },
);
schema.plugin(basePlugin);
schema.set('timestamps', false);
schema.plugin(tenantPlugin);
schema.index({ accountId: 1, at: -1 });
schema.index({ accountId: 1, action: 1, at: -1 });

const IMMUTABLE_OPS = [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'replaceOne',
  'findOneAndReplace',
  'findOneAndDelete',
  'deleteOne',
  'deleteMany',
] as const;

// Audit entries are immutable; only the purge job may delete (option `allowPurge`).
for (const op of IMMUTABLE_OPS) {
  schema.pre(op, function (this: Query<unknown, unknown>) {
    const { allowPurge } = this.getOptions() as { allowPurge?: boolean };
    if (op === 'deleteMany' && allowPurge) return;
    throw new Error('Audit log entries are immutable');
  });
}
schema.pre('save', function () {
  if (!this.isNew) throw new Error('Audit log entries are immutable');
});

/** Who did what (data-model.md §2.1, docs/conventions/audit.md). Immutable. */
export const AuditLogModel: Model<AuditLogDoc> =
  (mongoose.models.AuditLog as Model<AuditLogDoc> | undefined) ??
  mongoose.model<AuditLogDoc>('AuditLog', schema, 'auditLogs');
