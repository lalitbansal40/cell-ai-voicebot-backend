import type { Types } from 'mongoose';

import type { FlowGraph } from '../../core/engine/schema';
import { FlowGraphSchema } from '../../core/engine/schema';
import { hasErrors } from '../../core/engine/validate';
import { SYSTEM_VARIABLE_NAMES, coerce, type RunValue } from '../../core/engine/variables';
import { ContactModel, type ContactDoc } from '../../db/models/contact.model';
import { FlowVersionModel, type FlowVersionDoc } from '../../db/models/flow-version.model';
import type { FlowDoc } from '../../db/models/flow.model';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors/app-error';
import { contactTemplateValues } from '../ai-agents/functions.service';
import { accountVariables, contactVariables } from '../ai-agents/variables';

import { flowInvalid, issuesOf, type FlowsDeps } from './flows.service';

/** Start values of a run (simulator or call): display values + server-only contact facts. */
export interface RunContact {
  display: Record<string, string>;
  phone: string | null;
  externalId: string | null;
  templateValues: Record<string, unknown>;
}

export const loadContact = async (
  accountId: Types.ObjectId,
  contactId: Types.ObjectId,
): Promise<RunContact> => {
  const names = (await accountVariables(accountId)).map((v) => v.name);
  const { values } = await contactVariables(accountId, contactId, names);
  const contact = await ContactModel.findOne({ _id: contactId, accountId }).lean<ContactDoc>();
  if (!contact) throw new NotFoundError('Contact not found');
  return {
    display: values,
    phone: contact.phoneE164,
    externalId: contact.externalId ?? null,
    templateValues: contactTemplateValues(contact),
  };
};

/** Typed values from the simulator / tester: contact fields, flow variables (+ test phone). */
export const resolveStartValues = async (
  accountId: Types.ObjectId,
  graph: FlowGraph,
  input: {
    contactId: Types.ObjectId | null;
    variables?: Record<string, string> | null | undefined;
    testPhone?: string | null | undefined;
  },
): Promise<{ contact: RunContact; seed: Record<string, RunValue> }> => {
  const seed: Record<string, RunValue> = {};
  if (input.contactId) return { contact: await loadContact(accountId, input.contactId), seed };
  const contactNames = new Set((await accountVariables(accountId)).map((v) => v.name));
  const flowTypes = new Map(graph.variables.map((v) => [v.name, v.type]));
  const display: Record<string, string> = {};
  const details: { path: string; message: string }[] = [];
  for (const [name, raw] of Object.entries(input.variables ?? {})) {
    const value = raw.trim();
    if (contactNames.has(name)) display[name] = value;
    else if (flowTypes.has(name)) {
      try {
        seed[name] = coerce(flowTypes.get(name) ?? 'text', value);
      } catch {
        details.push({
          path: `variables.${name}`,
          message: `Not a valid ${flowTypes.get(name) ?? 'value'}`,
        });
      }
    } else {
      details.push({
        path: `variables.${name}`,
        message: SYSTEM_VARIABLE_NAMES.has(name)
          ? 'Set by the flow — read-only'
          : 'Not a contact field or flow variable',
      });
    }
  }
  if (details.length) throw new ValidationError(details);
  const testPhone = input.testPhone ?? null;
  if (testPhone && !display.phone_last4) display.phone_last4 = testPhone.slice(-4);
  return {
    contact: {
      display,
      phone: testPhone,
      externalId: null,
      templateValues: testPhone ? { phone: testPhone, name: display.name ?? '' } : {},
    },
    seed,
  };
};

/** Resolves `draft` / `published` / a number to a graph (+ snapshot for drafts). */
export const resolveVersion = async (
  flow: FlowDoc,
  version: 'draft' | 'published' | number,
  deps: FlowsDeps,
) => {
  if (version === 'draft') {
    const graph = FlowGraphSchema.parse(flow.draft);
    const issues = await issuesOf(flow.accountId, graph, deps);
    if (hasErrors(issues)) throw flowInvalid(issues);
    return { graph, versionRef: 'draft' as const, checksum: flow.draftChecksum ?? '' };
  }
  const number = version === 'published' ? flow.publishedVersion : version;
  if (!number)
    throw new ConflictError('CONFLICT_INVALID_STATE', 'This flow has no published version.');
  const v = await FlowVersionModel.findOne({
    flowId: flow._id,
    version: number,
  }).lean<FlowVersionDoc>();
  if (!v) throw new NotFoundError('Version not found');
  // stored versions keep what was saved (template graphs omit defaults); fill them like drafts
  const parsed = FlowGraphSchema.safeParse(v.graph);
  const graph = parsed.success ? parsed.data : (v.graph as unknown as FlowGraph);
  return { graph, versionRef: number, checksum: v.checksum };
};
