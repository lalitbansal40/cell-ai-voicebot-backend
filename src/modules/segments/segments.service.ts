import type { Request } from 'express';
import { Types } from 'mongoose';

import { CONTACT_LIMITS } from '../../config/limits';
import { isDuplicateKeyError } from '../../db/errors';
import { ContactModel, type ContactDoc } from '../../db/models/contact.model';
import { SegmentModel, type SegmentDoc } from '../../db/models/segment.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter, toObjectId } from '../../shared/auth/tenant';
import { ConflictError, NotFoundError } from '../../shared/errors/app-error';
import { auditRequest } from '../audit/audit.service';
import { toPublicContact, type PublicContact } from '../contacts/contacts.service';
import { compileContext, loadContactContext, type ContactContext } from '../contacts/context';
import { compileContactFilter, compileOrThrow } from '../contacts/filter/compile';
import type { ContactFilter } from '../contacts/filter/filter.schema';

const NAME_COLLATION = { locale: 'en', strength: 2 } as const;

export interface PublicSegment {
  id: string;
  name: string;
  filter: ContactFilter;
  invalidConditions: number[];
  contactCount?: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Indexes of conditions that can't be compiled any more (e.g. field deleted). */
const invalidConditions = (ctx: ContactContext, filter: ContactFilter): number[] => {
  const { problems } = compileContactFilter(ctx.accountId, filter, compileContext(ctx));
  const indexes = problems
    .map((p) => /^conditions\.(\d+)\./.exec(p.path)?.[1])
    .filter((i): i is string => i !== undefined)
    .map(Number);
  return [...new Set(indexes)];
};

const countFor = async (ctx: ContactContext, filter: ContactFilter): Promise<number> =>
  ContactModel.countDocuments(
    compileContactFilter(ctx.accountId, filter, compileContext(ctx)).query,
  );

const toPublicSegment = (
  ctx: ContactContext,
  s: SegmentDoc,
  contactCount?: number,
): PublicSegment => {
  const filter = s.filter as ContactFilter;
  return {
    id: s._id.toString(),
    name: s.name,
    filter,
    invalidConditions: invalidConditions(ctx, filter),
    ...(contactCount === undefined ? {} : { contactCount }),
    createdBy: s.createdBy.toString(),
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
};

const findSegment = async (req: Request, id: string): Promise<SegmentDoc> => {
  const _id = toObjectId(id);
  const segment = _id
    ? await SegmentModel.findOne({ _id, ...tenantFilter(req) }).lean<SegmentDoc>()
    : null;
  if (!segment) throw new NotFoundError('Segment not found');
  return segment;
};

const assertUniqueName = async (
  accountId: Types.ObjectId,
  name: string,
  exceptId?: Types.ObjectId,
) => {
  const existing = await SegmentModel.findOne({
    accountId,
    name,
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
  })
    .collation(NAME_COLLATION)
    .select({ _id: 1 })
    .lean();
  if (existing) {
    throw new ConflictError('CONFLICT_DUPLICATE', 'A segment with this name already exists.', [
      { path: 'name', message: 'Already exists', existingId: existing._id.toString() },
    ]);
  }
};

const rethrowDuplicate = (err: unknown): never => {
  if (isDuplicateKeyError(err))
    throw new ConflictError('CONFLICT_DUPLICATE', 'A segment with this name already exists.');
  throw err;
};

export const listSegments = async (req: Request, { withCounts }: { withCounts: boolean }) => {
  const ctx = await loadContactContext(tenantFilter(req).accountId);
  const segments = await SegmentModel.find({ accountId: ctx.accountId })
    .sort({ createdAt: -1 })
    .lean<SegmentDoc[]>();
  const counts = withCounts
    ? await Promise.all(segments.map((s) => countFor(ctx, s.filter as ContactFilter)))
    : [];
  return segments.map((s, i) => toPublicSegment(ctx, s, withCounts ? counts[i] : undefined));
};

export const getSegment = async (req: Request, id: string): Promise<PublicSegment> => {
  const segment = await findSegment(req, id);
  const ctx = await loadContactContext(segment.accountId);
  return toPublicSegment(ctx, segment, await countFor(ctx, segment.filter));
};

export const createSegment = async (
  req: Request,
  body: { name: string; filter: ContactFilter },
): Promise<PublicSegment> => {
  const ctx = await loadContactContext(tenantFilter(req).accountId);
  compileOrThrow(ctx.accountId, body.filter, compileContext(ctx));
  await assertUniqueName(ctx.accountId, body.name);
  if (
    (await SegmentModel.countDocuments({ accountId: ctx.accountId })) >=
    CONTACT_LIMITS.segmentsPerAccount
  ) {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      `An account can have at most ${CONTACT_LIMITS.segmentsPerAccount} segments.`,
    );
  }
  try {
    const doc = await SegmentModel.create({
      accountId: ctx.accountId,
      name: body.name,
      filter: body.filter,
      createdBy: new Types.ObjectId(requireAuth(req).userId),
    });
    return toPublicSegment(
      ctx,
      doc.toObject({ transform: false }),
      await countFor(ctx, body.filter),
    );
  } catch (err) {
    return rethrowDuplicate(err);
  }
};

export const updateSegment = async (
  req: Request,
  id: string,
  body: { name?: string; filter?: ContactFilter },
): Promise<PublicSegment> => {
  const segment = await findSegment(req, id);
  const ctx = await loadContactContext(segment.accountId);
  if (body.filter) compileOrThrow(ctx.accountId, body.filter, compileContext(ctx));
  if (body.name !== undefined) await assertUniqueName(ctx.accountId, body.name, segment._id);
  try {
    const updated = await SegmentModel.findOneAndUpdate(
      { _id: segment._id, accountId: ctx.accountId },
      {
        $set: {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.filter ? { filter: body.filter } : {}),
        },
      },
      { returnDocument: 'after' },
    ).lean<SegmentDoc>();
    if (!updated) throw new NotFoundError('Segment not found');
    return toPublicSegment(ctx, updated, await countFor(ctx, updated.filter));
  } catch (err) {
    return rethrowDuplicate(err);
  }
};

export const deleteSegment = async (req: Request, id: string): Promise<void> => {
  const segment = await findSegment(req, id);
  await SegmentModel.deleteOne({ _id: segment._id, accountId: segment.accountId });
  await auditRequest(req, 'segment.deleted', {
    target: { type: 'segment', id: segment._id.toString() },
    meta: { name: segment.name },
  });
};

export const previewSegment = async (
  req: Request,
  filter: ContactFilter,
): Promise<{ count: number; sample: PublicContact[] }> => {
  const ctx = await loadContactContext(tenantFilter(req).accountId);
  const query = compileOrThrow(ctx.accountId, filter, compileContext(ctx));
  const [count, sample] = await Promise.all([
    ContactModel.countDocuments(query),
    ContactModel.find(query).sort({ createdAt: -1, _id: -1 }).limit(5).lean<ContactDoc[]>(),
  ]);
  return { count, sample: sample.map(toPublicContact) };
};
