import type { Request } from 'express';
import { Types } from 'mongoose';
import type { z } from 'zod';

import { AiAgentModel, type AiAgentDoc } from '../../db/models/ai-agent.model';
import type { CallSource } from '../../db/models/call.model';
import { defaultDryRun } from '../../db/models/campaign.model';
import { ContactModel, type ContactDoc } from '../../db/models/contact.model';
import { FlowVersionModel } from '../../db/models/flow-version.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter } from '../../shared/auth/tenant';
import {
  AppError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/app-error';
import { contactVariables } from '../ai-agents/variables';
import { auditRequest } from '../audit/audit.service';
import type { CallManager } from '../calls/call.service';
import type { StartCallBody } from '../calls/calls.schema';
import { findCall, viewOne } from '../calls/calls.service';
import { findFlow, type FlowsDeps } from '../flows/flows.service';
import { resolveStartValues, resolveVersion } from '../flows/run-values';

import { accountFacts } from './campaigns.service';
import { decideDial, loadContactFacts, type DialDecision } from './dial-guard';

/** Guard refusals in words (PHASE_8_PROMPT §1 "Single call"). */
const refuse = (
  decision: Exclude<DialDecision, { kind: 'dial' }>,
  facts: { week: number; perWeek: number; minGapMinutes: number },
): AppError => {
  if (decision.kind === 'wait' && decision.reason === 'window') {
    return new AppError('CALL_OUTSIDE_WINDOW', undefined, [
      { path: 'window', message: decision.until.toISOString() },
    ]);
  }
  const notAllowed = (message: string) =>
    new AppError('CALL_NOT_ALLOWED', undefined, [{ path: 'contactId', message }]);
  if (decision.kind === 'wait' && decision.reason === 'min_gap') {
    return notAllowed(`Called less than ${String(facts.minGapMinutes)} minutes ago`);
  }
  if (decision.kind === 'wait') {
    return notAllowed(
      facts.week >= facts.perWeek ? 'Weekly call limit reached' : 'Daily call limit reached',
    );
  }
  if (decision.kind === 'skip') {
    if (decision.reason === 'dnd') return notAllowed('On the do-not-call list');
    if (decision.reason === 'opted_out') return notAllowed('Opted out');
    if (decision.reason === 'invalid_phone') return notAllowed('Not a valid phone number');
    if (decision.reason === 'contact_deleted') return new NotFoundError('Contact not found');
  }
  // suspended accounts never get here (writes are refused earlier)
  return new ForbiddenError();
};

/**
 * `POST /calls` — one outbound call to a contact through the same dial guard
 * (window, DND, opt-out, caps, minimum gap) and slots as campaigns. Until phone
 * lines exist (Phase 13) it uses the dry-run provider: simulated, never charged.
 */
export const startSingleCall = async (
  req: Request,
  body: z.infer<typeof StartCallBody>,
  deps: FlowsDeps & { manager: CallManager },
) => {
  const auth = requireAuth(req);
  const { accountId } = tenantFilter(req);
  const contact = await ContactModel.findOne({ _id: body.contactId, accountId }).lean<ContactDoc>();
  if (!contact) throw new NotFoundError('Contact not found');

  let source: CallSource;
  let variables: Record<string, string>;
  let templateKey: string | null = null;
  if (body.flowId) {
    if (!auth.permissions.has('flows.read')) throw new ForbiddenError();
    const flow = await findFlow(accountId, body.flowId);
    const resolved = await resolveVersion(flow, body.version ?? 'published', deps);
    const { graph } = resolved;
    // never 'draft' here (the body allows published / a number only)
    const versionRef = resolved.versionRef as number;
    const version = await FlowVersionModel.findOne({ flowId: flow._id, version: versionRef })
      .select({ _id: 1 })
      .lean<{ _id: Types.ObjectId }>();
    const values = await resolveStartValues(accountId, graph, {
      contactId: contact._id,
      variables: undefined,
      testPhone: undefined,
    });
    source = {
      kind: 'flow',
      flowId: flow._id,
      flowVersionRef: versionRef,
      flowVersionId: version?._id ?? null,
    };
    variables = values.contact.display;
    templateKey = flow.templateKey ?? null;
  } else {
    if (!auth.permissions.has('agents.read')) throw new ForbiddenError();
    const agent = await AiAgentModel.findOne({ _id: body.agentId, accountId }).lean<AiAgentDoc>();
    if (!agent) throw new NotFoundError('Agent not found');
    if (!agent.isActive) {
      throw new ValidationError([{ path: 'agentId', message: 'This agent is switched off' }]);
    }
    source = { kind: 'agent', agentId: agent._id };
    variables = (await contactVariables(accountId, contact._id, agent.allowedVariables)).values;
  }

  const account = await accountFacts(accountId);
  const now = new Date();
  const facts = await loadContactFacts({
    accountId: accountId.toString(),
    contactId: contact._id.toString(),
    phone: contact.phoneE164,
    mode: 'dry_run',
    now,
    timezone: account.timezone,
    minGapMinutes: account.caps.minGapMinutes,
  });
  const decision = decideDial({
    now,
    accountStatus: account.status,
    campaignStatus: null,
    window: account.window,
    timezone: account.timezone,
    endAt: null,
    ...facts,
    caps: account.caps,
    money: 'ok',
  });
  if (decision.kind !== 'dial') {
    throw refuse(decision, {
      week: facts.counts.week,
      perWeek: account.caps.perWeek,
      minGapMinutes: account.caps.minGapMinutes,
    });
  }

  const dryRun = defaultDryRun();
  const out = await deps.manager.startOutboundCall({
    accountId: accountId.toString(),
    provider: 'dryrun',
    to: contact.phoneE164,
    contactId: contact._id.toString(),
    source,
    variables,
    initiatedBy: auth.userId ?? null,
    dryRun: {
      seed: new Types.ObjectId().toString(),
      mix: dryRun.mix,
      scenarios: dryRun.scenarios,
      templateKey,
      // real time: the contact page follows the call live
      speed: 1,
    },
  });
  await auditRequest(req, 'call.triggered', {
    target: { type: 'call', id: out.callId },
    meta: {
      provider: 'dryrun',
      source: source.kind,
      contactId: contact._id.toString(),
      ...(source.flowId
        ? { flowId: source.flowId.toString(), version: source.flowVersionRef }
        : {}),
      ...(source.agentId ? { agentId: source.agentId.toString() } : {}),
    },
  });
  return viewOne(await findCall(accountId, out.callId));
};
