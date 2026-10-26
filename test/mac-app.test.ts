import { describe, it, expect } from 'vitest';
import { agentEnv, agentPlist, infoPlist, plist } from '../scripts/mac-app.mjs';

describe('Mac app installer', () => {
  it('writes the launchd agent that keeps the family server running', () => {
    const p = agentPlist({ root: '/Users/w/AITeacher', node: '/usr/local/bin/node', env: { ADW_PIN: '1234', PATH: '/usr/bin' }, logs: '/Users/w/Library/Logs/AIDiscoveryWorld' });
    expect(p).toContain('<key>Label</key><string>world.aidiscovery.server</string>');
    expect(p).toContain('<string>/Users/w/AITeacher/node_modules/tsx/dist/cli.mjs</string><string>/Users/w/AITeacher/apps/server/src/main.ts</string>');
    expect(p).toContain('<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>');
    expect(p).toContain('<key>ADW_PIN</key><string>1234</string>');
    expect(plist({ a: 'x<&>y' })).toContain('<string>x&lt;&amp;&gt;y</string>');
  });

  it('needs the parent PIN once, then keeps it for updates', () => {
    expect(() => agentEnv({ PATH: '/usr/bin' })).toThrow(/ADW_PIN=你的PIN/);
    const first = agentEnv({ ADW_PIN: '207588', PATH: '/opt/homebrew/bin:/usr/bin', HOME: '/Users/w', ADW_VOICE_ZH: 'Lilian', SECRET: 'x' });
    expect(first).toMatchObject({ ADW_PIN: '207588', ADW_VOICE_ZH: 'Lilian', PATH: '/opt/homebrew/bin:/usr/bin', LANG: 'zh_CN.UTF-8' });
    expect(first).not.toHaveProperty('SECRET');
    expect(agentEnv({}, first)).toMatchObject({ ADW_PIN: '207588', PATH: '/opt/homebrew/bin:/usr/bin', HOME: '/Users/w' });
  });

  it('lets the app load the local server and records which source it was built from', () => {
    const p = infoPlist('abc123');
    expect(p).toContain('<key>NSAllowsLocalNetworking</key><true/>');
    expect(p).toContain('<key>ADWSourceHash</key><string>abc123</string>');
  });
});
