import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { AUDIT_ACTIONS, RETIRED_AUDIT_ACTIONS } from '../../src/modules/audit/audit-actions';
import { AUDIT_RETENTION_DAYS } from '../../src/modules/audit/audit-purge';
import { sanitizeMeta } from '../../src/modules/audit/audit.service';
import { safeCell } from '../../src/modules/contact-imports/error-report';
import { assertXlsxSafe } from '../../src/modules/contact-imports/parsers/xlsx';
import { cleanForExport } from '../../src/modules/privacy/account-export.job';
import { buildTestApp } from '../helpers/test-app';

const src = path.resolve(__dirname, '..', '..', 'src');
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? files(path.join(dir, e.name))
      : e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')
        ? [path.join(dir, e.name)]
        : [],
  );
const all = files(src).map((f) => ({ file: path.relative(src, f), text: readFileSync(f, 'utf8') }));
const code = all.map((f) => f.text).join('\n');

describe('audit', () => {
  it('keeps two years', () => {
    expect(AUDIT_RETENTION_DAYS).toBe(730);
  });

  it('every action in the catalogue is written somewhere in the code', () => {
    const catalogue = all.find((f) => f.file === path.join('modules', 'audit', 'audit-actions.ts'));
    const others = all
      .filter((f) => f !== catalogue)
      .map((f) => f.text)
      .join('\n');
    const never = AUDIT_ACTIONS.filter(
      (a) => !others.includes(`'${a}'`) && !others.includes(`\`${a}\``),
    );
    // built from a template string in the code that writes them
    const dynamic = (a: string) => /^(team|whatsapp|template|campaign|call|flow|agent)\./.test(a);
    const retired = new Set<string>(RETIRED_AUDIT_ACTIONS);
    expect(never.filter((a) => !dynamic(a) && !retired.has(a))).toEqual([]);
    expect(RETIRED_AUDIT_ACTIONS.every((a) => AUDIT_ACTIONS.includes(a))).toBe(true);
  });

  it('no audit call puts a phone, an e-mail or a message text in meta', () => {
    const offenders: string[] = [];
    for (const { file, text } of all) {
      for (const m of text.matchAll(/meta:\s*\{([^}]*)\}/g)) {
        if (
          /\b(phoneE164|phone|email|text|summary|transcript)\s*[:,]/.test(m[1] ?? '') &&
          !/maskEmail|maskPhone/.test(m[1] ?? '')
        ) {
          offenders.push(`${file}: ${(m[1] ?? '').trim().slice(0, 60)}`);
        }
      }
    }
    // audit lines only: other `meta:` objects (Meta API, list pages) are told apart here
    const auditOnly = offenders.filter((o) => !/whatsapp|meta-|public-api|inbox\.openapi/.test(o));
    expect(auditOnly).toEqual([]);
    expect(code).toContain('sanitizeMeta');
  });

  it('sanitizeMeta drops secrets at any depth', () => {
    const clean = JSON.stringify(sanitizeMeta({ a: { password: 'x', token: 'y' }, keep: 1 }));
    expect(clean).not.toContain('"x"');
    expect(clean).not.toContain('"y"');
    expect(clean).toContain('keep');
  });
});

describe('files', () => {
  it.each(['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\t=1', '\r=1'])('neutralises %j', (cell) => {
    expect(safeCell(cell).startsWith("'")).toBe(true);
  });

  it('leaves normal text alone', () => {
    expect(safeCell('Asha Verma')).toBe('Asha Verma');
    expect(safeCell('')).toBe('');
  });

  it('every CSV writer neutralises cells', () => {
    const writers = all.filter(
      (f) =>
        /text\/csv|\.csv'|\.csv`/.test(f.text) &&
        /(export|report|ledger|compliance)/i.test(f.file) &&
        !f.file.endsWith('.schema.ts') &&
        !f.file.endsWith('.routes.ts'),
    );
    expect(writers.length).toBeGreaterThan(0);
    const unsafe = writers.filter((f) => !/safeCell|csvCell/.test(f.text)).map((f) => f.file);
    expect(unsafe).toEqual([]);
  });

  /** A zip whose central directory claims a huge unpacked size. */
  const fakeZip = (entries: number, size: number) => {
    const central = Buffer.alloc(46 * entries);
    for (let i = 0; i < entries; i += 1) {
      central.writeUInt32LE(0x02014b50, i * 46);
      central.writeUInt32LE(size, i * 46 + 24);
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries, 10);
    eocd.writeUInt32LE(0, 16);
    return Buffer.concat([central, eocd]);
  };

  it('refuses a zip bomb before opening it', () => {
    expect(() => assertXlsxSafe(fakeZip(1, 1024), 2048)).not.toThrow();
    expect(() => assertXlsxSafe(fakeZip(3, 1024), 2048)).toThrow();
    expect(() => assertXlsxSafe(fakeZip(1, 0xffffffff), 2048)).toThrow();
    expect(() =>
      assertXlsxSafe(Buffer.from('not a zip at all, but long enough to be read')),
    ).toThrow();
  });

  it('an account export never carries a secret field', () => {
    const out = JSON.stringify(
      cleanForExport({
        tokenSealed: 'a',
        keyHash: 'b',
        passwordHash: 'c',
        mfa: { x: 1 },
        name: 'n',
      }),
    );
    expect(out).toBe('{"name":"n"}');
  });
});

describe('global limit', () => {
  it('never refuses a signed provider webhook, however many arrive from one address', async () => {
    const app = buildTestApp({}, { rateLimit: { limit: 1 } });
    const path = '/api/v1/webhooks/meta';
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) statuses.push((await request(app).post(path).send({})).status);
    expect(statuses).not.toContain(429);
  });
});
