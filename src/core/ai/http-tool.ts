import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

import { AI_LIMITS } from '../../config/limits';
import type { AgentFunction } from '../../db/models/ai-agent.model';

import { addressBlockReason, urlBlockReason, type GuardPolicy } from './ip-guard';
import { open } from './secret-box';

// ── Templating ────────────────────────────────────────────────────────────

/** Values a function template can use. `contact` never reaches the model. */
export interface TemplateContext {
  args: Record<string, unknown>;
  contact: Record<string, unknown>;
  agentName: string;
  company: string;
}

const TOKEN = /\{\{\s*(args\.[a-zA-Z0-9_]+|contact\.[a-zA-Z0-9_]+|agent\.name|company)\s*\}\}/g;
const ANY_TOKEN = /\{\{\s*([^}]*?)\s*\}\}/g;
const WHOLE_TOKEN =
  /^\{\{\s*(args\.[a-zA-Z0-9_]+|contact\.[a-zA-Z0-9_]+|agent\.name|company)\s*\}\}$/;

/** Every `{{token}}` in a text (valid or not), trimmed. */
export const templateTokens = (text: string): string[] =>
  [...text.matchAll(ANY_TOKEN)].map((m) => m[1] ?? '');

export const isKnownToken = (token: string): boolean =>
  new RegExp(`^${TOKEN.source}$`).test(`{{${token}}}`);

const lookupToken = (token: string, ctx: TemplateContext): unknown => {
  if (token === 'company') return ctx.company;
  if (token === 'agent.name') return ctx.agentName;
  const [scope, key = ''] = token.split('.');
  const source = scope === 'args' ? ctx.args : ctx.contact;
  return Object.hasOwn(source, key) ? source[key] : undefined;
};

const asText = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : '';

const renderText = (
  text: string,
  ctx: TemplateContext,
  warnings: Set<string>,
  encode: (s: string) => string = (s) => s,
): string =>
  text.replace(TOKEN, (_all, token: string) => {
    const value = lookupToken(token, ctx);
    if (value === undefined || value === null || value === '') {
      warnings.add(`missing:${token}`);
      return '';
    }
    return encode(asText(value));
  });

/** URL: every token value is URL-encoded (never changes the structure). */
export const renderUrl = (template: string, ctx: TemplateContext, warnings: Set<string>): string =>
  renderText(template, ctx, warnings, encodeURIComponent);

/** Header value: raw text; CR / LF after rendering is refused (header injection). */
export const renderHeader = (
  template: string,
  ctx: TemplateContext,
  warnings: Set<string>,
): string | null => {
  const value = renderText(template, ctx, warnings);
  return /[\r\n\0]/.test(value) ? null : value;
};

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * JSON body: rendered on the parsed tree (never string concatenation). A leaf
 * that is exactly one token keeps the value's JSON type (`"{{args.amount}}"` → 500).
 */
export const renderBody = (template: Json, ctx: TemplateContext, warnings: Set<string>): Json => {
  if (typeof template === 'string') {
    const whole = WHOLE_TOKEN.exec(template);
    if (whole?.[1]) {
      const value = lookupToken(whole[1], ctx);
      if (value === undefined || value === null || value === '') {
        warnings.add(`missing:${whole[1]}`);
        return '';
      }
      return typeof value === 'number' || typeof value === 'boolean' ? value : asText(value);
    }
    return renderText(template, ctx, warnings);
  }
  if (Array.isArray(template)) return template.map((item) => renderBody(item, ctx, warnings));
  if (template && typeof template === 'object') {
    return Object.fromEntries(
      Object.entries(template).map(([k, v]) => [k, renderBody(v, ctx, warnings)]),
    );
  }
  return template;
};

// ── Result path ───────────────────────────────────────────────────────────

export const RESULT_PATH = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+){0,4}$/;

/** `data.items.0.status` → value (numeric segments index arrays); `undefined` when missing. */
export const pickPath = (value: unknown, path: string): unknown => {
  let current: unknown = value;
  for (const segment of path.split('.')) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) current = current[Number(segment)];
    else if (current && typeof current === 'object' && Object.hasOwn(current, segment)) {
      current = (current as Record<string, unknown>)[segment];
    } else return undefined;
  }
  return current;
};

// ── Executor ──────────────────────────────────────────────────────────────

export type ToolErrorCode =
  | 'blocked'
  | 'timeout'
  | 'too_large'
  | 'invalid_json'
  | 'network'
  | 'too_many_redirects'
  | 'invalid_request'
  | 'secret_unavailable'
  | `http_${number}`;

export interface HttpToolResult {
  ok: boolean;
  httpStatus: number | null;
  durationMs: number;
  /** Extracted result (after `resultPath`), `null` on errors. */
  result: unknown;
  /** What the model sees: JSON / text, ≤ 2,000 chars. */
  resultText: string;
  bytes: number;
  warnings: string[];
  error?: ToolErrorCode;
}

/** Test hooks: a fake resolver and a dial map (fake public IP → local stub). */
export interface HttpToolOptions {
  policy: GuardPolicy;
  resolve?: (host: string) => Promise<string[]>;
  dial?: (address: string) => string;
  now?: () => number;
}

const defaultResolve = async (host: string): Promise<string[]> =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

class ToolFailure extends Error {
  constructor(
    readonly code: ToolErrorCode,
    readonly httpStatus: number | null = null,
  ) {
    super(code);
  }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 2;

interface Hop {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

/** Resolves the host, checks every address, returns the one to connect to. */
const pinAddress = async (url: URL, options: HttpToolOptions): Promise<string> => {
  if (urlBlockReason(url, options.policy)) throw new ToolFailure('blocked');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try {
      addresses = await (options.resolve ?? defaultResolve)(host);
    } catch {
      throw new ToolFailure('network');
    }
  }
  if (!addresses.length) throw new ToolFailure('network');
  // every address must pass — a mixed answer (public + private) is refused
  if (addresses.some((a) => addressBlockReason(a, options.policy)))
    throw new ToolFailure('blocked');
  const first = addresses[0] ?? '';
  return options.dial ? options.dial(first) : first;
};

const send = (
  hop: Hop,
  address: string,
  signal: AbortSignal,
): Promise<{ res: IncomingMessage; body: Buffer }> =>
  new Promise((resolve, reject) => {
    const https = hop.url.protocol === 'https:';
    const headers: OutgoingHttpHeaders = {
      'user-agent': 'CellAI-Agent/1.0',
      accept: 'application/json, text/plain;q=0.9, */*;q=0.5',
      ...hop.headers,
      host: hop.url.host,
    };
    if (hop.body !== null) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(hop.body);
    }
    const req = (https ? httpsRequest : httpRequest)({
      host: address,
      port: hop.url.port || (https ? 443 : 80),
      path: `${hop.url.pathname}${hop.url.search}`,
      method: hop.method,
      headers,
      signal,
      ...(https ? { servername: hop.url.hostname.replace(/^\[|\]$/g, '') } : {}),
    });
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > AI_LIMITS.functionResponseMaxBytes) {
          res.destroy();
          req.destroy();
          reject(new ToolFailure('too_large', res.statusCode ?? null));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }));
      res.on('error', () => reject(new ToolFailure(signal.aborted ? 'timeout' : 'network')));
    });
    req.on('error', () => reject(new ToolFailure(signal.aborted ? 'timeout' : 'network')));
    if (hop.body !== null) req.write(hop.body);
    req.end();
  });

const truncate = (text: string, max = AI_LIMITS.toolResultMaxChars): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

export const resultToText = (value: unknown): string =>
  truncate(typeof value === 'string' ? value : (JSON.stringify(value) ?? ''));

/** A function call as a prepared first hop (rendered URL, headers, body). */
export interface PreparedRequest {
  hop: Hop;
  warnings: Set<string>;
}

/**
 * Renders a function for one call. Secret headers are opened here and only
 * live in memory for the request.
 */
export const prepareRequest = (
  fn: Pick<AgentFunction, 'method' | 'url' | 'headers' | 'bodyTemplate'>,
  ctx: TemplateContext,
  secretKey: Buffer,
): PreparedRequest => {
  const warnings = new Set<string>();
  let url: URL;
  try {
    url = new URL(renderUrl(fn.url, ctx, warnings));
  } catch {
    throw new ToolFailure('invalid_request');
  }
  const headers: Record<string, string> = {};
  for (const h of fn.headers) {
    let raw: string;
    if (h.secret) {
      try {
        raw = open(secretKey, h.sealed ?? '');
      } catch {
        throw new ToolFailure('secret_unavailable');
      }
    } else raw = h.value ?? '';
    const value = h.secret ? raw : renderHeader(raw, ctx, warnings);
    if (value === null || /[\r\n\0]/.test(value)) throw new ToolFailure('invalid_request');
    headers[h.name.toLowerCase()] = value;
  }
  let body: string | null = null;
  if (fn.method !== 'GET' && fn.bodyTemplate) {
    body = JSON.stringify(renderBody(JSON.parse(fn.bodyTemplate) as Json, ctx, warnings));
  }
  return { hop: { url, method: fn.method, headers, body }, warnings };
};

/**
 * Calls a custom function through the SSRF guard (PHASE_5_PROMPT §1 HTTP executor).
 * Never throws for request problems — they come back as `{ ok: false, error }`
 * so the model (or the Test button) can react.
 */
export const executeFunction = async (
  fn: Pick<
    AgentFunction,
    'method' | 'url' | 'headers' | 'bodyTemplate' | 'resultPath' | 'timeoutMs'
  >,
  ctx: TemplateContext,
  secretKey: Buffer,
  options: HttpToolOptions,
): Promise<HttpToolResult> => {
  const now = options.now ?? Date.now;
  const started = now();
  const warnings = new Set<string>();
  const fail = (code: ToolErrorCode, httpStatus: number | null = null): HttpToolResult => ({
    ok: false,
    httpStatus,
    durationMs: now() - started,
    result: null,
    resultText: JSON.stringify({ ok: false, error: code }),
    bytes: 0,
    warnings: [...warnings].sort(),
    error: code,
  });
  const signal = AbortSignal.timeout(fn.timeoutMs);
  try {
    const prepared = prepareRequest(fn, ctx, secretKey);
    prepared.warnings.forEach((w) => warnings.add(w));
    let hop = prepared.hop;
    for (let redirects = 0; ; redirects += 1) {
      const address = await pinAddress(hop.url, options);
      const { res, body } = await send(hop, address, signal);
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (REDIRECTS.has(status) && location) {
        if (redirects >= MAX_REDIRECTS) return fail('too_many_redirects', status);
        const next = new URL(location, hop.url);
        const sameOrigin = next.origin === hop.url.origin;
        const keepBody = status === 307 || status === 308;
        hop = {
          url: next,
          method: keepBody ? hop.method : 'GET',
          // credentials never follow a redirect to another origin
          headers: sameOrigin ? hop.headers : {},
          body: keepBody ? hop.body : null,
        };
        continue;
      }
      if (status < 200 || status > 299) return fail(`http_${status}`, status);
      const type = String(res.headers['content-type'] ?? '').toLowerCase();
      const text = body.toString('utf8');
      let parsed: unknown = text;
      if (type.includes('json')) {
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          return fail('invalid_json', status);
        }
      }
      let result = parsed;
      if (fn.resultPath) {
        result = pickPath(parsed, fn.resultPath);
        if (result === undefined) {
          warnings.add('result_path_not_found');
          result = null;
        }
      }
      return {
        ok: true,
        httpStatus: status,
        durationMs: now() - started,
        result,
        resultText: resultToText(result),
        bytes: body.length,
        warnings: [...warnings].sort(),
      };
    }
  } catch (err) {
    if (err instanceof ToolFailure)
      return fail(signal.aborted ? 'timeout' : err.code, err.httpStatus);
    if (signal.aborted) return fail('timeout');
    return fail('network');
  }
};
