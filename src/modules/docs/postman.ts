import { PUBLIC_API_TAG, type OpenApiDoc } from './public-spec';

/**
 * Postman collection v2.1 of the public API (DOCS-T6, L10): one folder per area tag,
 * `{{baseUrl}}` + `{{apiKey}}` variables, example bodies and an example answer per request.
 */

type Json = Record<string, unknown>;
interface Op {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: { name: string; in: string; required?: boolean }[];
  requestBody?: {
    content?: Record<string, { example?: unknown; examples?: Record<string, { value: unknown }> }>;
  };
  responses?: Record<
    string,
    { description?: string; content?: Record<string, { example?: unknown }> }
  >;
  'x-scope'?: string | string[];
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

const bodyOf = (op: Op): unknown => {
  const media = op.requestBody?.content?.['application/json'];
  if (!media) return undefined;
  if (media.example !== undefined) return media.example;
  const first = Object.values(media.examples ?? {})[0];
  return first?.value;
};

const requestFor = (method: string, path: string, op: Op) => {
  const segments = path
    .replace(/^\//, '')
    .split('/')
    .map((s) => s.replace(/^\{(\w+)\}$/, ':$1'));
  const query = (op.parameters ?? [])
    .filter((p) => p.in === 'query')
    .map((p) => ({ key: p.name, value: '', disabled: !p.required }));
  const pathVars = (op.parameters ?? [])
    .filter((p) => p.in === 'path')
    .map((p) => ({ key: p.name, value: '' }));
  const body = bodyOf(op);
  const idempotent =
    /Idempotency-Key/.test(op.description ?? '') || /Idempotency-Key/.test(op.summary ?? '');
  return {
    method: method.toUpperCase(),
    header: [
      ...(body !== undefined ? [{ key: 'Content-Type', value: 'application/json' }] : []),
      ...(idempotent ? [{ key: 'Idempotency-Key', value: '{{$guid}}' }] : []),
    ],
    url: {
      raw: `{{baseUrl}}/${segments.join('/')}`,
      host: ['{{baseUrl}}'],
      path: segments,
      ...(query.length ? { query } : {}),
      ...(pathVars.length ? { variable: pathVars } : {}),
    },
    ...(body !== undefined
      ? {
          body: {
            mode: 'raw',
            raw: JSON.stringify(body, null, 2),
            options: { raw: { language: 'json' } },
          },
        }
      : {}),
    description: [
      op.description ?? '',
      op['x-scope'] ? `\n\nScope: \`${([] as string[]).concat(op['x-scope']).join(', ')}\`` : '',
    ].join(''),
  };
};

export const buildPostmanCollection = (spec: OpenApiDoc): Json => {
  const folders = new Map<string, Json[]>();
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const op = item[method] as Op | undefined;
      if (!op) continue;
      const area = (op.tags ?? []).find((t) => t !== PUBLIC_API_TAG) ?? 'Other';
      const request = requestFor(method, path, op);
      const ok = Object.entries(op.responses ?? {}).find(([code]) => /^2\d\d$/.test(code));
      const example = ok?.[1].content?.['application/json']?.example;
      const entry: Json = {
        name: op.summary ?? `${method.toUpperCase()} ${path}`,
        request,
        response:
          ok && example !== undefined
            ? [
                {
                  name: 'Example',
                  originalRequest: request,
                  status: ok[1].description ?? 'OK',
                  code: Number(ok[0]),
                  header: [{ key: 'Content-Type', value: 'application/json' }],
                  body: JSON.stringify(example, null, 2),
                  _postman_previewlanguage: 'json',
                },
              ]
            : [],
      };
      folders.set(area, [...(folders.get(area) ?? []), entry]);
    }
  }
  const order = (spec.tags ?? []).map((t) => t.name);
  const names = [...folders.keys()].sort(
    (a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99),
  );
  const server = ((spec.servers as { url: string }[] | undefined) ?? [])[0]?.url ?? '';
  return {
    info: {
      name: 'NotifyNow API',
      description:
        'NotifyNow public API. Set `apiKey` (Settings → API keys) and `baseUrl` (your NotifyNow address, e.g. https://wa.notifynow.in) in the collection variables. Guides: /api/docs.',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    auth: {
      type: 'apikey',
      apikey: [
        { key: 'key', value: 'X-API-Key', type: 'string' },
        { key: 'value', value: '{{apiKey}}', type: 'string' },
        { key: 'in', value: 'header', type: 'string' },
      ],
    },
    variable: [
      { key: 'baseUrl', value: server || 'https://wa.notifynow.in' },
      { key: 'apiKey', value: '' },
    ],
    item: names.map((name) => ({ name, item: folders.get(name) ?? [] })),
  };
};
