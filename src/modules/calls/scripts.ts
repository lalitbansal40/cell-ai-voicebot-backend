import type { CallDoc } from '../../db/models/call.model';

import type { CallScript } from './session';

export interface ScriptChoice {
  script: CallScript;
  voice: string;
  language: string;
  /** Flow `settings.maxDurationSec` / agent `maxCallDurationSec`. */
  maxDurationSec?: number;
}

export type ScriptFactory = (call: CallDoc) => Promise<ScriptChoice>;

/** Placeholder until the flow host (T7.6) and the AI agent session (T7.7) are wired. */
export const noScripts: ScriptFactory = () =>
  Promise.reject(new Error('No call scripts are available yet'));
