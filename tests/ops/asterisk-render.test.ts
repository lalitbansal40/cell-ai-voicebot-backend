import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const kit = path.resolve(__dirname, '../../deploy/asterisk');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ARI = 'ari-test-password-0123456789';
const BASE = { SIP_HOST: 'sip.example.net', ARI_PASSWORD: ARI, PATH: process.env.PATH ?? '' };

const render = (env: Record<string, string>) => {
  const out = mkdtempSync(path.join(tmpdir(), 'cav-ast-'));
  dirs.push(out);
  const run = spawnSync('bash', [path.join(kit, 'render.sh'), path.join(kit, 'conf'), out], {
    env,
    encoding: 'utf8',
  });
  const files = Object.fromEntries(
    run.status === 0
      ? readdirSync(out).map((name) => [name, readFileSync(path.join(out, name), 'utf8')])
      : [],
  ) as Record<string, string>;
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, files };
};

describe('asterisk config render (ADR 0050)', () => {
  it('renders IP auth: the trunk is the only endpoint, matched by address', () => {
    const r = render({ ...BASE, SIP_TRUNK_IPS: '203.0.113.10,203.0.113.11' });
    expect(r.status).toBe(0);
    const pjsip = r.files['pjsip.conf']!;
    expect(pjsip).toContain('contact=sip:sip.example.net:5060');
    expect(pjsip).toContain('dtmf_mode=rfc4733');
    expect(pjsip).toContain('allow=ulaw,alaw');
    expect(pjsip).toContain('direct_media=no');
    expect(pjsip).not.toContain('outbound_auth=');
    expect(pjsip).not.toMatch(/^\[anonymous\]/m);
    expect(pjsip.match(/^type=endpoint$/gm)).toHaveLength(1);
    expect(r.files['pjsip_identify.conf']).toContain('match=203.0.113.10,203.0.113.11');
    expect(r.files['pjsip_register.conf']).toBe('');
  });

  it('renders registration auth without printing the password', () => {
    const r = render({
      ...BASE,
      SIP_AUTH: 'register',
      SIP_USERNAME: 'acct',
      SIP_PASSWORD: 'trunk-secret-1',
    });
    expect(r.status).toBe(0);
    expect(r.files['pjsip.conf']).toContain('outbound_auth=trunk-auth');
    expect(r.files['pjsip_register.conf']).toContain('password=trunk-secret-1');
    expect(r.files['pjsip_register.conf']).toContain('server_uri=sip:sip.example.net:5060');
    expect(r.files['pjsip_identify.conf']).toBe('');
    expect(r.stdout + r.stderr).not.toContain('trunk-secret-1');
    expect(r.stdout + r.stderr).not.toContain(ARI);
  });

  it('keeps ARI on loopback, RTP in 20000-20999 and AMI off by default', () => {
    const r = render({ ...BASE, SIP_TRUNK_IPS: '203.0.113.10' });
    expect(r.files['http.conf']).toContain('bindaddr=127.0.0.1');
    expect(r.files['http.conf']).toContain('bindport=8088');
    expect(r.files['rtp.conf']).toContain('rtpstart=20000');
    expect(r.files['rtp.conf']).toContain('rtpend=20999');
    expect(r.files['rtp.conf']).toContain('strictrtp=yes');
    expect(r.files['manager.conf']).toContain('enabled=no');
    expect(r.files['modules.conf']).toContain('autoload=no');
    expect(r.files['ari.conf']).toContain(`password=${ARI}`);
  });

  it('drops settings left empty and leaves no placeholder', () => {
    const r = render({ ...BASE, SIP_TRUNK_IPS: '203.0.113.10' });
    const all = Object.values(r.files).join('\n');
    expect(all).not.toMatch(/\$\{(SIP|ARI)_/);
    expect(r.files['pjsip.conf']).not.toMatch(/^external_media_address=$/m);
    expect(r.files['pjsip.conf']).not.toMatch(/^local_net=$/m);
    const comments = all.split('\n').filter((line) => line.startsWith(';'));
    expect(comments.join('\n')).not.toContain(ARI);
  });

  it('refuses unsafe or incomplete settings', () => {
    expect(render({ ...BASE }).stderr).toContain('SIP_AUTH=ip needs SIP_TRUNK_IPS');
    expect(render({ ...BASE, SIP_AUTH: 'register' }).stderr).toContain('needs SIP_USERNAME');
    expect(render({ ...BASE, SIP_TRUNK_IPS: 'x', ARI_PASSWORD: 'short' }).stderr).toContain(
      'at least 24 characters',
    );
    expect(render({ ...BASE, SIP_TRUNK_IPS: 'x', SIP_TRANSPORT: 'ws' }).status).not.toBe(0);
    expect(render({ ...BASE, SIP_TRUNK_IPS: 'x', SIP_AUTH: 'guest' }).status).not.toBe(0);
    expect(
      render({ ...BASE, SIP_TRUNK_IPS: 'x', SIP_RTP_START: '21000', SIP_RTP_END: '20000' }).status,
    ).not.toBe(0);
  });

  it('only answers trunk calls with a refusal until inbound calling exists', () => {
    const r = render({ ...BASE, SIP_TRUNK_IPS: '203.0.113.10' });
    const dialplan = r.files['extensions.conf']!;
    expect(dialplan).toMatch(/\[cav-in\][\s\S]*Hangup\(21\)/);
    expect(dialplan).toContain('AMD(2500,1500,800,5000,100,50,3,256)');
    expect(dialplan).toContain('Stasis(${CAV_APP},amd,${AMDSTATUS},${AMDCAUSE})');
  });
});
