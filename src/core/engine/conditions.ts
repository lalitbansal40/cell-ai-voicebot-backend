import type { Operator } from './schema';
import { isYmd, type RunValue } from './variables';

const NUMBER = /^-?\d+(\.\d+)?$/;

const asNumber = (value: RunValue | string): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && NUMBER.test(value.trim())) return Number(value.trim());
  return null;
};
const asText = (value: RunValue | string): string =>
  value === null ? '' : String(value).trim().toLowerCase();
const isEmpty = (value: RunValue | string): boolean =>
  value === null || (typeof value === 'string' && value.trim() === '');

/**
 * One condition: `left` is the variable's typed value, `right` the rendered value
 * text (PHASE_6_PROMPT §1 Conditions). Never throws — impossible comparisons are false.
 */
export const evaluateCondition = (
  operator: Operator,
  left: RunValue,
  right: string | null,
): boolean => {
  const r = right ?? '';
  switch (operator) {
    case 'is_empty':
      return isEmpty(left);
    case 'is_not_empty':
      return !isEmpty(left);
    case 'equals':
    case 'not_equals': {
      const a = asNumber(left);
      const b = asNumber(r);
      const same = a !== null && b !== null ? a === b : asText(left) === asText(r);
      return operator === 'equals' ? same : !same;
    }
    case 'contains':
      return asText(left).includes(asText(r));
    case 'not_contains':
      return !asText(left).includes(asText(r));
    case 'starts_with':
      return asText(left).startsWith(asText(r));
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = asNumber(left);
      const b = asNumber(r);
      if (a === null || b === null) return false;
      if (operator === 'gt') return a > b;
      if (operator === 'gte') return a >= b;
      if (operator === 'lt') return a < b;
      return a <= b;
    }
    case 'in_list':
      return r
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
        .includes(asText(left));
    case 'date_before':
    case 'date_after': {
      const a = typeof left === 'string' ? left.trim() : '';
      const b = r.trim();
      if (!isYmd(a) || !isYmd(b)) return false;
      return operator === 'date_before' ? a < b : a > b;
    }
  }
};

export interface RuleLike {
  id: string;
  match: 'all' | 'any';
  conditions: { variable: string; operator: Operator; value: string | null }[];
}

/**
 * First rule (in order) whose conditions hold → `rule_<id>`, else `else`.
 * `resolve` gives the variable's value and the rendered condition value.
 */
export const pickRule = (
  rules: readonly RuleLike[],
  resolve: (condition: RuleLike['conditions'][number]) => { left: RunValue; right: string | null },
): string => {
  for (const rule of rules) {
    const results = rule.conditions.map((c) => {
      const { left, right } = resolve(c);
      return evaluateCondition(c.operator, left, right);
    });
    const ok = rule.match === 'all' ? results.every(Boolean) : results.some(Boolean);
    if (ok) return `rule_${rule.id}`;
  }
  return 'else';
};
