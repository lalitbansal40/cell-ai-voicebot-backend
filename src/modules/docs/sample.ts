/**
 * Example values for a JSON schema (public docs, DOCS-T4): realistic fake data by property
 * name and format — ids, times, phones, money in micros — never real customer data.
 */

type Schema = Record<string, unknown>;

export const SAMPLE = {
  id: '6720f0a1b2c3d4e5f6a7b8c9',
  at: '2026-11-05T09:30:00.000Z',
  date: '2026-11-05',
  phone: '+919000000001',
  name: 'Asha Verma',
  email: 'asha@example.com',
  url: 'https://example.com/hooks/notifynow',
} as const;

const stringFor = (key: string, schema: Schema): string => {
  const k = key.toLowerCase();
  if (schema.format === 'date-time' || /at$|time$|until$/.test(k)) return SAMPLE.at;
  if (schema.format === 'date' || /date$/.test(k)) return SAMPLE.date;
  if (k === 'id' || /id$/.test(k)) return SAMPLE.id;
  if (k.includes('phone') || k === 'to' || k === 'from') return SAMPLE.phone;
  if (k.includes('email')) return SAMPLE.email;
  if (k.includes('url') || k.includes('link')) return SAMPLE.url;
  if (k.includes('last4')) return '0001';
  if (k === 'name' || k.endsWith('name')) return SAMPLE.name;
  if (k === 'currency') return 'INR';
  if (k === 'language') return 'en';
  if (k.includes('timezone')) return 'Asia/Kolkata';
  if (k === 'cursor' || k === 'nextcursor') return 'eyJhdCI6IjIwMjYtMTEtMDUifQ';
  return 'string';
};

const numberFor = (key: string, schema: Schema): number => {
  const k = key.toLowerCase();
  if (k.endsWith('micros')) return 1_250_000;
  if (k.endsWith('bps')) return 1500;
  if (k.endsWith('pct')) return 50;
  if (k.includes('sec') || k.includes('duration')) return 94;
  if (k === 'version' || k.endsWith('version')) return 1;
  const min = typeof schema.minimum === 'number' ? schema.minimum : 0;
  return Math.max(min, k.includes('count') || k.includes('total') ? 12 : 1);
};

export const sampleFor = (
  schema: unknown,
  components: Record<string, unknown>,
  key = '',
  depth = 0,
): unknown => {
  if (!schema || typeof schema !== 'object' || depth > 8) return null;
  const s = schema as Schema;
  if (typeof s.$ref === 'string') {
    return sampleFor(components[s.$ref.split('/').pop() ?? ''], components, key, depth + 1);
  }
  if (s.example !== undefined) return s.example;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum.find((v) => v !== null) ?? s.enum[0];
  if (s.const !== undefined) return s.const;
  for (const k of ['anyOf', 'oneOf', 'allOf'] as const) {
    const options = s[k] as unknown[] | undefined;
    if (Array.isArray(options)) {
      const usable: unknown = options.find(
        (o) => (o as Schema).type !== 'null' && !(o as Schema).not,
      );
      return sampleFor(usable ?? options[0], components, key, depth + 1);
    }
  }
  const types = s.type as string | string[] | undefined;
  const type: string | undefined = Array.isArray(types) ? types.find((t) => t !== 'null') : types;
  if (type === 'object' || s.properties) {
    const out: Record<string, unknown> = {};
    for (const [name, prop] of Object.entries((s.properties ?? {}) as Record<string, unknown>)) {
      out[name] = sampleFor(prop, components, name, depth + 1);
    }
    return out;
  }
  if (type === 'array') return [sampleFor(s.items, components, key, depth + 1)];
  if (type === 'string') return stringFor(key, s);
  if (type === 'integer' || type === 'number') return numberFor(key, s);
  if (type === 'boolean') return !key.toLowerCase().startsWith('is') ? true : false;
  return null;
};
