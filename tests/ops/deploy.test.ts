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

  it('waits for live calls before replacing a running release, and not on the first deploy', () => {
    const root = temp();
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    for (const folder of ['env', 'uploads', 'deploy', `src/${B}/backend`, `src/${B}/frontend/dist`])
      mkdirSync(path.join(root, folder), { recursive: true });
    writeFileSync(path.join(root, 'env/backend.env'), 'APP_URL=https://prod.example.com\n');
    writeFileSync(path.join(root, 'env/compose.env'), '');
    writeFileSync(path.join(root, `src/${B}/frontend.sha`), A);
    writeFileSync(path.join(root, `src/${B}/frontend/dist/index.html`), 'web');
    const log = path.join(root, 'docker.log');
    writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env bash\necho "$*" >> ${log}\nexit 0\n`, {
      mode: 0o755,
    });
    writeFileSync(path.join(bin, 'curl'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      CAV_ROOT: root,
      CAV_PROJECT: 'cav-prod-rehearsal',
    };
    const deploy = () =>
      execFileSync('bash', [path.join(scriptRoot, 'deploy.sh'), B], { env, encoding: 'utf8' });
    // first deploy: nothing is running yet
    deploy();
    expect(readFileSync(log, 'utf8')).not.toContain('live-calls');
    // a release replacing a running one waits for calls before starting the new containers
    rmSync(log);
    mkdirSync(path.join(root, `releases/${A}/web`), { recursive: true });
    rmSync(path.join(root, 'releases/current'));
    symlinkSync(A, path.join(root, 'releases/current'));
    deploy();
    const calls = readFileSync(log, 'utf8').split('\n');
    const wait = calls.findIndex(
      (l) => l.includes('dist/ops/live-calls.js') && l.endsWith(' sh 600'),
    );
    const swap = calls.findIndex((l) => l.includes('up -d --no-deps api worker'));
    expect(wait).toBeGreaterThan(-1);
    expect(wait).toBeLessThan(swap);
  });

  describe('release.sh', () => {
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
        cwd,
        encoding: 'utf8',
        stdio: 'pipe',
      });
    /** An installed server, with backup and deploy recording their turn, and a client repo. */
    const server = (tagMessage: string, tag = `release-20261102-${B.slice(0, 7)}`) => {
      const root = temp();
      const origin = path.join(root, 'origin');
      const sub = path.join(origin, 'cell-ai-voicebot-phase13');
      mkdirSync(path.join(sub, 'backend'), { recursive: true });
      mkdirSync(path.join(sub, 'frontend'), { recursive: true });
      writeFileSync(path.join(sub, 'backend/marker'), 'be');
      writeFileSync(path.join(sub, 'frontend/marker'), 'fe');
      git(origin, 'init', '-q');
      git(origin, 'add', '-A');
      git(origin, 'commit', '-qm', 'code');
      git(origin, 'tag', '-a', tag, '-m', tagMessage);
      mkdirSync(path.join(root, 'env'));
      mkdirSync(path.join(root, 'deploy/scripts'), { recursive: true });
      for (const name of ['common.sh']) {
        writeFileSync(
          path.join(root, 'deploy/scripts', name),
          readFileSync(path.join(scriptRoot, name), 'utf8'),
        );
      }
      const release = path.join(root, 'deploy/scripts/release.sh');
      writeFileSync(
        release,
        readFileSync(path.resolve(scriptRoot, '../../production/scripts/release.sh'), 'utf8'),
        { mode: 0o755 },
      );
      const order = path.join(root, 'order.log');
      for (const name of ['backup.sh', 'deploy.sh']) {
        writeFileSync(
          path.join(root, 'deploy/scripts', name),
          `#!/usr/bin/env bash\necho "${name} $*" >> ${order}\n`,
          { mode: 0o755 },
        );
      }
      writeFileSync(
        path.join(root, 'env/backend.env'),
        ['APP_URL', 'MONGODB_URI', 'REDIS_URL', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']
          .concat(['ENCRYPTION_KEY', 'SUPPRESSION_HMAC_KEY'])
          .map((k) => `${k}=secret-value-${k}`)
          .join('\n'),
      );
      writeFileSync(path.join(root, 'env/ops.env'), `RELEASE_REPO_URL=${origin}\n`);
      // the release record runs in a container: docker answers here, and writes down what it ran
      const bin = path.join(root, 'bin');
      mkdirSync(bin);
      writeFileSync(
        path.join(bin, 'docker'),
        `#!/usr/bin/env bash\necho "docker $*" >> ${order}\n`,
        {
          mode: 0o755,
        },
      );
      const run = (arg = tag) =>
        execFileSync('bash', [release, arg], {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            CAV_ROOT: root,
            CAV_PROJECT: 'cav-prod-rehearsal',
          },
          encoding: 'utf8',
          stdio: 'pipe',
        });
      return { root, order, run };
    };
    const MESSAGE = `backend ${B}\nfrontend ${C}`;

    it('backs up first, unpacks the tag, deploys the backend sha and records it', () => {
      const s = server(MESSAGE);
      const output = s.run();
      const order = readFileSync(s.order, 'utf8').trim().split('\n');
      expect(order.slice(0, 2)).toEqual(['backup.sh ', `deploy.sh ${B}`]);
      expect(order[2]).toContain(`ops-record.js release --tag release-20261102-${B.slice(0, 7)}`);
      expect(readFileSync(path.join(s.root, `src/${B}/backend/marker`), 'utf8')).toBe('be');
      expect(readFileSync(path.join(s.root, `src/${B}/frontend/marker`), 'utf8')).toBe('fe');
      expect(readFileSync(path.join(s.root, `src/${B}/frontend.sha`), 'utf8').trim()).toBe(C);
      expect(readFileSync(path.join(s.root, 'logs/releases.log'), 'utf8')).toContain(
        `backend=${B} frontend=${C}`,
      );
      expect(output).not.toContain('secret-value');
    });

    it('refuses a bad tag name, a tag naming no shas, and a missing env key, before any change', () => {
      const s = server(MESSAGE);
      expect(() => s.run('main')).toThrow();
      expect(() => s.run(`release-20261102-${C.slice(0, 7)}`)).toThrow();
      const noShas = server('just text');
      expect(() => noShas.run()).toThrow();
      const noKey = server(MESSAGE);
      writeFileSync(path.join(noKey.root, 'env/backend.env'), 'APP_URL=https://x.example\n');
      expect(() => noKey.run()).toThrow(/Command failed/);
      for (const failed of [s, noShas, noKey]) {
        expect(readdirSync(failed.root)).not.toContain('order.log');
      }
    });
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
