import type { VariableValue } from '../../../db/models/contact.model';

export interface FieldRule {
  key: string;
  required: boolean;
  defaultValue?: string | number | null;
}

/**
 * Fills defaults for absent values (`applyDefaults`, on create / import only)
 * and lists required keys that still have no value.
 */
export const applyDefaultsAndRequired = (
  fields: readonly FieldRule[],
  variables: Readonly<Record<string, VariableValue>>,
  { applyDefaults }: { applyDefaults: boolean },
): { variables: Record<string, VariableValue>; missing: string[] } => {
  const result: Record<string, VariableValue> = { ...variables };
  const missing: string[] = [];
  for (const field of fields) {
    if (result[field.key] !== undefined) continue;
    if (applyDefaults && field.defaultValue !== undefined && field.defaultValue !== null) {
      result[field.key] = field.defaultValue;
    } else if (field.required) {
      missing.push(field.key);
    }
  }
  return { variables: result, missing };
};
