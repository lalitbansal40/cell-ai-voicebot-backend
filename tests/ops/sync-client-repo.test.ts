import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const script = path.resolve(__dirname, '../../scripts/sync-client-repo.sh');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();

const SUB = 'cell-ai-voicebot-phase13';

/** Our two repos, the client's bare origin and its clone holding a tagged first release. */
const world = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cav-sync-test-'));
  dirs.push(root);
  const repo = (name: string, file: string, text: string) => {
    const dir = path.join(root, name);
    mkdirSync(dir);
    git(dir, 'init', '-q');
    writeFileSync(path.join(dir, file), text);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'one');
    return dir;
  };
  const backend = repo('backend', 'be.txt', 'be 1');
  const frontend = repo('frontend', 'fe.txt', 'fe 1');
  const origin = path.join(root, 'origin.git');
  mkdirSync(origin);
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  const client = path.join(root, 'client');
  mkdirSync(path.join(client, SUB, 'backend'), { recursive: true });
  mkdirSync(path.join(client, SUB, 'frontend'), { recursive: true });
  git(client, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(client, SUB, 'backend/be.txt'), 'be 1');
  writeFileSync(path.join(client, SUB, 'frontend/fe.txt'), 'fe 1');
  git(client, 'add', '-A');
  git(client, 'commit', '-qm', 'first');
  git(client, 'remote', 'add', 'origin', origin);
  git(client, 'push', '-q', '-u', 'origin', 'main');
  const sync = (...args: string[]) =>
    execFileSync('bash', [script, ...args], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.com',
        CAV_BACKEND_REPO: backend,
        CAV_FRONTEND_REPO: frontend,
        CAV_CLIENT_REPO: client,
      },
    });
  return { backend, frontend, client, origin, sync };
};

const headOf = (dir: string) => git(dir, 'rev-parse', 'HEAD');
const commitTo = (dir: string, file: string, text: string) => {
  writeFileSync(path.join(dir, file), text);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'more');
  return headOf(dir);
};

describe('sync-client-repo.sh', () => {
  it('refuses a new release before the running one is tagged', () => {
    const w = world();
    expect(() => w.sync(headOf(w.backend), headOf(w.frontend), '--dry-run')).toThrow(
      /no release tag/,
    );
  });

  it('tags an existing commit with both shas, annotated and pushed', () => {
    const w = world();
    const commit = headOf(w.client);
    w.sync('--tag-existing', commit, headOf(w.backend), headOf(w.frontend));
    const tag = git(w.client, 'tag', '-l', 'release-*');
    expect(tag).toMatch(new RegExp(`^release-\\d{8}-${headOf(w.backend).slice(0, 7)}$`));
    expect(git(w.client, 'tag', '-l', '--format=%(contents)', tag)).toContain(
      `backend ${headOf(w.backend)}`,
    );
    expect(git(w.origin, 'tag', '-l')).toBe(tag);
  });

  it('stops on commits since the last release and leaves the clone as it was', () => {
    const w = world();
    w.sync('--tag-existing', headOf(w.client), headOf(w.backend), headOf(w.frontend));
    writeFileSync(path.join(w.client, SUB, 'frontend/brand.txt'), 'client edit');
    git(w.client, 'add', '-A');
    git(w.client, 'commit', '-qm', 'client branding');
    git(w.client, 'push', '-q', 'origin', 'main');
    expect(() => w.sync(headOf(w.backend), headOf(w.frontend), '--dry-run')).toThrow(
      /commits since/,
    );
    expect(readFileSync(path.join(w.client, SUB, 'frontend/brand.txt'), 'utf8')).toBe(
      'client edit',
    );
  });

  it('stops when the clone differs from what was released, and never overwrites it', () => {
    const w = world();
    // a client edit made before the tag: no commit after it, but the folder differs from the shas
    writeFileSync(path.join(w.client, SUB, 'backend/be.txt'), 'client edit');
    git(w.client, 'add', '-A');
    git(w.client, 'commit', '-qm', 'edit');
    git(w.client, 'push', '-q', 'origin', 'main');
    w.sync('--tag-existing', headOf(w.client), headOf(w.backend), headOf(w.frontend));
    expect(() => w.sync(headOf(w.backend), headOf(w.frontend), '--dry-run')).toThrow(
      /client changed files/,
    );
    expect(existsSync(path.join(w.client, SUB, 'backend/be.txt'))).toBe(true);
    expect(git(w.client, 'status', '--porcelain')).toBe('');
  });

  it('releases new code: one commit, a tag, pushed, with the build workflow', () => {
    const w = world();
    w.sync('--tag-existing', headOf(w.client), headOf(w.backend), headOf(w.frontend));
    const be = commitTo(w.backend, 'be.txt', 'be 2');
    const fe = commitTo(w.frontend, 'fe.txt', 'fe 2');
    expect(w.sync(be, fe, '--dry-run')).toContain('Dry run');
    expect(readFileSync(path.join(w.client, SUB, 'backend/be.txt'), 'utf8')).toBe('be 1');
    expect(git(w.client, 'status', '--porcelain')).toBe('');
    expect(w.sync(be, fe)).toContain('Released');
    expect(readFileSync(path.join(w.client, SUB, 'backend/be.txt'), 'utf8')).toBe('be 2');
    expect(existsSync(path.join(w.client, '.github/workflows/build.yml'))).toBe(true);
    expect(git(w.origin, 'rev-parse', 'main')).toBe(headOf(w.client));
    expect(git(w.origin, 'tag', '-l', `release-*-${be.slice(0, 7)}`)).not.toBe('');
  });

  it.each([
    ['a key', 'x.txt', 'token = sk-' + 'a'.repeat(40)],
    ['a database login', 'x.txt', ['mongodb+srv://user', 'pass@cluster.example.net/db'].join(':')],
    ['an env file', '.env', 'A=b'],
  ])('stops on %s and leaves the clone clean', (_name, file, text) => {
    const w = world();
    w.sync('--tag-existing', headOf(w.client), headOf(w.backend), headOf(w.frontend));
    const be = commitTo(w.backend, file, text);
    expect(() => w.sync(be, headOf(w.frontend))).toThrow(/stopped/);
    expect(git(w.client, 'status', '--porcelain')).toBe('');
    expect(git(w.origin, 'rev-parse', 'main')).toBe(headOf(w.client));
  });
});
