import type { Request } from 'express';
import { Types } from 'mongoose';

import { diffSummary, graphChecksum } from '../../core/engine/canonical';
import type { FlowGraph } from '../../core/engine/schema';
import { hasErrors } from '../../core/engine/validate';
import { notifyAccount } from '../../core/realtime/notify';
import { FlowVersionModel, type FlowVersionDoc } from '../../db/models/flow-version.model';
import { FlowModel, type FlowDoc } from '../../db/models/flow.model';
import { UserModel } from '../../db/models/user.model';
import { withTransaction } from '../../db/transaction';
import { requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter } from '../../shared/auth/tenant';
import { ConflictError, NotFoundError } from '../../shared/errors/app-error';
import { auditRequest } from '../audit/audit.service';

import {
  findFlow,
  flowInvalid,
  graphStats,
  issuesOf,
  latestVersion,
  notifyFlowUpdated,
  publicGraph,
  revisionConflict,
  toFlowView,
  type FlowsDeps,
} from './flows.service';

const iso = (d: Date) => d.toISOString();

const toVersionSummary = (
  v: FlowVersionDoc,
  current: number | null,
  users: Map<string, string>,
) => ({
  id: v._id.toString(),
  version: v.version,
  notes: v.notes ?? null,
  checksum: v.checksum,
  nodesCount: Array.isArray((v.graph as { nodes?: unknown[] }).nodes)
    ? (v.graph as { nodes: unknown[] }).nodes.length
    : 0,
  current: v.version === current,
  publishedBy: v.publishedBy
    ? { id: v.publishedBy.toString(), name: users.get(v.publishedBy.toString()) ?? '' }
    : null,
  publishedAt: iso(v.publishedAt),
});

const namesOf = async (ids: (Types.ObjectId | null)[]) => {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  const users = unique.length
    ? await UserModel.find({ _id: { $in: unique } })
        .select({ name: 1 })
        .lean<{ _id: Types.ObjectId; name: string }[]>()
    : [];
  return new Map(users.map((u) => [u._id.toString(), u.name]));
};

/** Publishes the draft as version N + 1 (PHASE_6_PLAN §1a). */
export const publishFlow = async (
  req: Request,
  id: string,
  body: { revision: number; notes?: string | null | undefined },
  deps: FlowsDeps,
) => {
  const { accountId } = tenantFilter(req);
  const userId = new Types.ObjectId(requireAuth(req).userId);
  const flow = await findFlow(accountId, id);
  if (flow.revision !== body.revision) throw await revisionConflict(flow._id);
  const graph = flow.draft as unknown as FlowGraph;
  const issues = await issuesOf(accountId, graph, deps);
  if (hasErrors(issues)) throw flowInvalid(issues);
  const checksum = graphChecksum(flow.draft);
  const latest = await latestVersion(flow._id);
  if (latest && latest.checksum === checksum) {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      `Nothing changed since v${String(latest.version)}.`,
    );
  }
  const previous = latest
    ? await FlowVersionModel.findById(latest._id).select({ graph: 1 }).lean<FlowVersionDoc>()
    : null;
  const stats = graphStats(graph);
  const number = (latest?.version ?? 0) + 1;
  const version = await withTransaction(async (session) => {
    const [created] = await FlowVersionModel.create(
      [
        {
          accountId,
          flowId: flow._id,
          version: number,
          graph: flow.draft,
          checksum,
          notes: body.notes?.trim() || null,
          agentIds: stats.agents,
          audioIds: stats.audios,
          publishedBy: userId,
          publishedAt: new Date(),
        },
      ],
      { session },
    );
    if (!created) throw new Error('version not created');
    const res = await FlowModel.updateOne(
      { _id: flow._id, accountId, revision: body.revision },
      {
        $set: {
          status: 'published',
          publishedVersionId: created._id,
          publishedVersion: number,
          hasUnpublishedChanges: false,
          updatedBy: userId,
        },
      },
      { session },
    );
    // a save landed between the read and this write → abort the version too
    if (res.modifiedCount !== 1) throw await revisionConflict(flow._id);
    return created.toObject({ transform: false });
  });
  await auditRequest(req, 'flow.published', {
    target: { type: 'flow', id: flow._id.toString() },
    meta: {
      version: number,
      notes: version.notes,
      ...diffSummary((previous?.graph as unknown as FlowGraph | null) ?? null, graph),
    },
  });
  notifyAccount(accountId.toString(), 'flow.published', {
    flowId: flow._id.toString(),
    version: number,
  });
  return toVersionSummary(version, number, await namesOf([userId]));
};

export const listVersions = async (req: Request, id: string) => {
  const { accountId } = tenantFilter(req);
  const flow = await findFlow(accountId, id);
  const versions = await FlowVersionModel.find({ flowId: flow._id, accountId })
    .sort({ version: -1 })
    .lean<FlowVersionDoc[]>();
  const users = await namesOf(versions.map((v) => v.publishedBy));
  return versions.map((v) => toVersionSummary(v, flow.publishedVersion ?? null, users));
};

const findVersion = async (flow: FlowDoc, version: number) => {
  const found = await FlowVersionModel.findOne({
    flowId: flow._id,
    accountId: flow.accountId,
    version,
  }).lean<FlowVersionDoc>();
  if (!found) throw new NotFoundError('Version not found');
  return found;
};

export const getVersion = async (req: Request, id: string, version: number) => {
  const flow = await findFlow(tenantFilter(req).accountId, id);
  const v = await findVersion(flow, version);
  return {
    ...toVersionSummary(v, flow.publishedVersion ?? null, await namesOf([v.publishedBy])),
    graph: publicGraph(v.graph),
  };
};

/** Copies a version into the draft (revision + 1). */
export const restoreVersion = async (
  req: Request,
  id: string,
  version: number,
  body: { revision: number },
  deps: FlowsDeps,
) => {
  const { accountId } = tenantFilter(req);
  const userId = requireAuth(req).userId;
  const flow = await findFlow(accountId, id);
  const v = await findVersion(flow, version);
  const latest = await latestVersion(flow._id);
  const graph = v.graph as unknown as FlowGraph;
  const updated = await FlowModel.findOneAndUpdate(
    { _id: flow._id, accountId, revision: body.revision },
    {
      $set: {
        draft: v.graph,
        draftChecksum: v.checksum,
        stats: graphStats(graph),
        hasUnpublishedChanges: !latest || latest.checksum !== v.checksum,
        updatedBy: new Types.ObjectId(userId),
      },
      $inc: { revision: 1 },
    },
    { returnDocument: 'after' },
  ).lean<FlowDoc>();
  if (!updated) throw await revisionConflict(flow._id);
  await auditRequest(req, 'flow.restored', {
    target: { type: 'flow', id: flow._id.toString() },
    meta: { fromVersion: version },
  });
  notifyFlowUpdated(updated, userId);
  return toFlowView(updated, deps);
};
