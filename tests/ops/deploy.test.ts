import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
const ATLAS =
  'mongodb+srv://cav_app:atlas-pass@cluster0.example.mongodb.net/cell_ai_voicebot?retryWrites=true&w=majority';

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

  it('keeps an external database URI (MongoDB Atlas) and still writes the redis URI', () => {
    const root = temp();
    mkdirSync(path.join(root, 'env'));
    writeFileSync(
      path.join(root, 'env/backend.env'),
      `APP_URL=https://staging.example.com\nMONGODB_URI=${ATLAS}\nREDIS_URL=\n`,
    );
    const output = execFileSync('bash', [path.join(scriptRoot, 'init-secrets.sh')], {
      env: { ...process.env, CAV_ROOT: root, CAV_PROJECT: 'cell-ai-voicebot-rehearsal' },
      encoding: 'utf8',
    });
    const backend = readFileSync(path.join(root, 'env/backend.env'), 'utf8');
    expect(backend).toContain(`MONGODB_URI=${ATLAS}\n`);
    expect(backend).toMatch(/^REDIS_URL=redis:\/\/:[a-f0-9]{64}@127\.0\.0\.1:6380$/m);
    expect(output).not.toContain('atlas-pass');
  });

  it('with MongoDB Atlas, deploy starts only redis and backup never puts the URI in arguments', () => {
    const root = temp();
    const bin = path.join(root, 'bin');
    for (const folder of ['bin', 'env', 'uploads', 'deploy', 'backups', 'target'])
      mkdirSync(path.join(root, folder));
    for (const folder of [`src/${B}/backend`, `src/${B}/frontend/dist`])
      mkdirSync(path.join(root, folder), { recursive: true });
    writeFileSync(path.join(root, `src/${B}/frontend.sha`), A);
    writeFileSync(path.join(root, `src/${B}/frontend/dist/index.html`), 'web');
    writeFileSync(
      path.join(root, 'env/backend.env'),
      `APP_URL=https://staging.example.com\nMONGODB_URI=${ATLAS}\n`,
    );
    writeFileSync(path.join(root, 'env/compose.env'), '');
    writeFileSync(path.join(root, 'env/backup.pub'), 'age1recipient');
    writeFileSync(path.join(root, 'uploads/keep.txt'), 'recording');
    const log = path.join(root, 'docker.log');
    const envLog = path.join(root, 'env-file.log');
    writeFileSync(
      path.join(bin, 'docker'),
      [
        '#!/usr/bin/env bash',
        `printf '%s\\n' "$*" >> '${log}'`,
        `if [[ "$1" == run ]]; then for a; do [[ "$a" == *mongo.env ]] && cat "$a" >> '${envLog}'; done; fi`,
        `case "$*" in *mongodump*) printf archive;; *mongosh*) printf '{"users":1}';; esac`,
      ].join('\n'),
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(bin, 'age'),
      '#!/usr/bin/env bash\nout=\nwhile [[ $# -gt 1 ]]; do case "$1" in -o) out="$2"; shift 2;; *) shift;; esac; done\ncp "$1" "$out"\n',
      { mode: 0o755 },
    );
    writeFileSync(path.join(bin, 'curl'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      CAV_ROOT: root,
      CAV_PROJECT: 'cell-ai-voicebot-rehearsal',
      CAV_BACKUP_TARGET: path.join(root, 'target'),
    };
    execFileSync('bash', [path.join(scriptRoot, 'deploy.sh'), B], { env, encoding: 'utf8' });
    const deployCalls = readFileSync(log, 'utf8');
    expect(deployCalls).toMatch(/ up -d --wait redis\n/);
    expect(deployCalls).not.toContain('--wait mongo');

    const output = execFileSync('bash', [path.join(scriptRoot, 'backup.sh')], {
      env,
      encoding: 'utf8',
    });
    expect(output).toContain('Backup complete');
    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain('mongodump --uri "$MONGODB_URI"');
    expect(calls + output).not.toContain('atlas-pass');
    // the URI reached the tools container only through the env file, removed afterwards
    expect(readFileSync(envLog, 'utf8')).toBe(`MONGODB_URI=${ATLAS}\n`.repeat(2));
    const stored = readdirSync(path.join(root, 'target'));
    expect(stored.filter((f) => f.endsWith('.age'))).toHaveLength(3);
    const counts = stored.find((f) => f.endsWith('-counts.json.age')) ?? '';
    expect(readFileSync(path.join(root, 'target', counts), 'utf8')).toBe('{"users":1}');
    expect(readdirSync(path.join(root, 'backups'))).toEqual(['last-success']);
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
