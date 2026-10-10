import { redactText } from '../ai/redact';

/**
 * Trace detail for a run mode: the simulator shows texts to its own user;
 * call traces never carry customer / spoken texts (PHASE_6_PLAN §1f).
 */
export const traceDetail = (
  mode: 'simulator' | 'call',
  detail: string | undefined,
  kind: 'text' | 'safe',
): string | undefined => {
  if (detail === undefined) return undefined;
  if (mode === 'simulator') return detail.slice(0, 500);
  return kind === 'safe' ? redactText(detail).slice(0, 200) : undefined;
};
