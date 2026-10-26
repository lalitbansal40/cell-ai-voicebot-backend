import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const scriptRoot = path.resolve(__dirname, '../../deploy/staging/scripts');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cav-ops-test-'));
  dirs.push(dir);
  return dir;
};
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

describe('staging scripts', () => {
  it('generates credentials once, updates both URIs, and never prints credentials', () => {
    const root = temp();
    mkdirSync(path.join(root, 'env'));
    writeFileSync(
      path.join(root, 'env/backend.env'),
      'APP_URL=https://staging.example.com\nMONGODB_URI=\nREDIS_URL=\n',
    );
    const env = { ...process.env, CAV_ROOT: root, CAV_PROJECT: 'cell-ai-voicebot-rehearsal' };
    const first = execFileSync('bash', [path.join(scriptRoot, 'init-secrets.sh')], {
      env,
      encoding: 'utf8',
    });
    const credentials = readFileSync(path.join(root, 'env/compose.env'), 'utf8');
    const second = execFileSync('bash', [path.join(scriptRoot, 'init-secrets.sh')], {
      env,
      encoding: 'utf8',
    });
    expect(readFileSync(path.join(root, 'env/compose.env'), 'utf8')).toBe(credentials);
    const mongo = /^MONGO_PASSWORD=(.+)$/m.exec(credentials)?.[1] ?? '';
    expect(mongo).toHaveLength(64);
    expect(readFileSync(path.join(root, 'env/backend.env'), 'utf8')).toContain(
      `mongodb://cav:${mongo}@127.0.0.1`,
    );
    expect(first + second).not.toContain(mongo);
  });

  it('switches both artifacts on success and rolls back a failed public smoke without touching uploads', () => {
    const root = temp();
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    for (const folder of [
      'env',
      'uploads',
      'deploy',
      `releases/${A}/web`,
      `src/${B}/backend`,
      `src/${B}/frontend/dist`,
    ])
      mkdirSync(path.join(root, folder), { recursive: true });
    writeFileSync(path.join(root, 'env/backend.env'), 'APP_URL=https://staging.example.com\n');
    writeFileSync(path.join(root, 'env/compose.env'), '');
    writeFileSync(path.join(root, `src/${B}/frontend.sha`), A);
    writeFileSync(path.join(root, `src/${B}/frontend/dist/index.html`), 'new web');
    writeFileSync(path.join(root, 'uploads/keep.txt'), 'recording');
    symlinkSync(A, path.join(root, 'releases/current'));
    writeFileSync(
      path.join(bin, 'docker'),
      '#!/usr/bin/env bash\ncase "$*" in *https://fail.example*) exit 1;; esac\nexit 0\n',
      { mode: 0o755 },
    );
    writeFileSync(path.join(bin, 'curl'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      CAV_ROOT: root,
      CAV_PROJECT: 'cell-ai-voicebot-rehearsal',
    };
    const output = execFileSync('bash', [path.join(scriptRoot, 'deploy.sh'), B], {
      env,
      encoding: 'utf8',
    });
    expect(output).toContain('Deploy ready');
    expect(readlinkSync(path.join(root, 'releases/current'))).toBe(B);
    expect(readlinkSync(path.join(root, 'releases/previous'))).toBe(A);
    expect(readFileSync(path.join(root, `releases/${B}/web/index.html`), 'utf8')).toBe('new web');
    for (const folder of [`src/${C}/backend`, `src/${C}/frontend/dist`])
      mkdirSync(path.join(root, folder), { recursive: true });
    writeFileSync(path.join(root, `src/${C}/frontend.sha`), A);
    writeFileSync(path.join(root, `src/${C}/frontend/dist/index.html`), 'failed web');
    // A new deployment now fails its nginx-facing probe. The previous healthy
    // running artifact and the earlier rollback target are both retained.
    expect(() =>
      execFileSync('bash', [path.join(scriptRoot, 'deploy.sh'), C], {
        env: { ...env, CAV_PUBLIC_URL: 'https://fail.example' },
        stdio: 'pipe',
      }),
    ).toThrow();
    expect(readlinkSync(path.join(root, 'releases/current'))).toBe(B);
    expect(readlinkSync(path.join(root, 'releases/previous'))).toBe(A);
    expect(readFileSync(path.join(root, 'uploads/keep.txt'), 'utf8')).toBe('recording');
    expect(() =>
      execFileSync('bash', [path.join(scriptRoot, 'deploy.sh'), '../bad'], { env, stdio: 'pipe' }),
    ).toThrow();
  });

  it('retains recent daily and weekly backups, deletes expired managed objects, and keeps unrelated files', () => {
    const root = temp();
    const now = Date.now();
    const stamp = (days: number) =>
      new Date(now - days * 86_400_000).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
    for (let day = 0; day < 36; day += 1)
      for (const kind of ['counts.json', 'mongo.archive.gz', 'uploads.tar.gz'])
        writeFileSync(path.join(root, `cav-${stamp(day)}-${kind}.age`), 'encrypted');
    writeFileSync(path.join(root, 'unrelated.txt'), 'keep');
    execFileSync('python3', [path.join(scriptRoot, 'retention.py'), root]);
    expect(readFileSync(path.join(root, 'unrelated.txt'), 'utf8')).toBe('keep');
    for (let day = 0; day < 7; day += 1)
      expect(readFileSync(path.join(root, `cav-${stamp(day)}-counts.json.age`), 'utf8')).toBe(
        'encrypted',
      );
    expect(() => readFileSync(path.join(root, `cav-${stamp(35)}-counts.json.age`))).toThrow();
  });
});
