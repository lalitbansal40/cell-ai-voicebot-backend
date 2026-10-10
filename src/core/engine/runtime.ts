import type { RunEndReason } from '../../db/models/flow-run.model';
import type { NodeType } from '../../db/models/flow.model';

import type { FlowGraph, FlowSettings, TypedNode } from './schema';
import type {
  EngineContext,
  FlowEffects,
  FlowInput,
  FlowOutput,
  FlowRunState,
  Waiting,
} from './types';
import type { RunValue, ValueType } from './variables';

/** What a node handler decides. */
export type Step = { exit: string } | { wait: Waiting } | { end: RunEndReason };

/** Services the engine gives node handlers (implemented in `engine.ts`). */
export interface NodeRuntime {
  readonly graph: FlowGraph;
  readonly settings: FlowSettings;
  readonly state: FlowRunState;
  readonly ctx: EngineContext;
  readonly effects: FlowEffects;
  /** Id of the input being handled (`start` input included). */
  readonly inputId: string;
  /** Display values for templates (contact, flow and system variables). */
  values(): Record<string, string>;
  /** Renders `{{…}}` with the display values (missing → `''`, traced). */
  render(text: string, nodeId: string): string;
  say(
    nodeId: string | null,
    text: string,
    opts?: { language?: string; interruptible?: boolean },
  ): void;
  push(output: FlowOutput): void;
  note(nodeId: string | null, text: string): void;
  getVar(name: string): RunValue;
  varType(name: string): ValueType;
  setVar(name: string, value: RunValue): void;
  /** Traces a node error and returns the `error` exit. */
  fail(nodeId: string, detail: string): Step;
}

export interface NodeHandler<T extends NodeType = NodeType> {
  enter(node: TypedNode<T>, rt: NodeRuntime): Promise<Step>;
  /** Waiting nodes only. */
  input?(node: TypedNode<T>, input: FlowInput, rt: NodeRuntime): Promise<Step>;
}
