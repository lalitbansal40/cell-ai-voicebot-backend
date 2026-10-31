import { guidesMarkdown } from './guides';

/** Routes open to API keys carry this tag (the docs page shows only these in production). */
export const PUBLIC_API_TAG = 'Public API';

type Json = Record<string, unknown>;
type Operation = { tags?: string[] } & Json;
export interface OpenApiDoc {
  info: Json;
  paths: Record<string, Record<string, unknown>>;
  tags?: { name: string }[];
  components?: { schemas?: Record<string, unknown> } & Json;
  [key: string]: unknown;
}

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

const refsIn = (value: unknown, out: Set<string>): Set<string> => {
  if (Array.isArray(value)) for (const v of value) refsIn(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === '$ref' && typeof v === 'string' && v.startsWith('#/components/schemas/'))
        out.add(v.slice('#/components/schemas/'.length));
      else refsIn(v, out);
    }
  }
  return out;
};

/**
 * The public docs (ADR 0045, plan §7 #6): only operations tagged `Public API`,
 * only the schemas they reach, and the hand-written guides as the description.
 * Dashboard-only routes and their schemas never appear.
 */
export const buildPublicSpec = (full: OpenApiDoc): OpenApiDoc => {
  const paths: OpenApiDoc['paths'] = {};
  for (const [path, item] of Object.entries(full.paths)) {
    const kept = Object.fromEntries(
      Object.entries(item).filter(
        ([method, op]) =>
          METHODS.has(method) && ((op as Operation).tags ?? []).includes(PUBLIC_API_TAG),
      ),
    );
    if (Object.keys(kept).length) paths[path] = kept;
  }
  const schemas = full.components?.schemas ?? {};
  const keep = refsIn(paths, new Set<string>());
  // follow refs inside the kept schemas until nothing new appears
  for (let grew = true; grew;) {
    grew = false;
    for (const name of [...keep]) {
      for (const ref of refsIn(schemas[name], new Set<string>())) {
        if (!keep.has(ref)) {
          keep.add(ref);
          grew = true;
        }
      }
    }
  }
  const usedTags = new Set(
    Object.values(paths).flatMap((item) =>
      Object.values(item).flatMap((op) => (op as Operation).tags ?? []),
    ),
  );
  return {
    ...full,
    info: { ...full.info, title: 'NotifyNow API', description: guidesMarkdown() },
    paths,
    ...(full.tags ? { tags: full.tags.filter((t) => usedTags.has(t.name)) } : {}),
    components: {
      ...full.components,
      schemas: Object.fromEntries(Object.entries(schemas).filter(([name]) => keep.has(name))),
    },
  };
};
