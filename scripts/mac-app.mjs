// The parent app for Mac ("AI 探索世界.app") and the background family server.
//   install  (default; run once in Terminal: ADW_PIN=xxxx npx -y pnpm@10.28.0 mac-app)
//            installs packages, builds the web apps and the Mac app, keeps the server running with launchd
//            (starts at login, restarts if it stops) and puts the app in Applications.
//   update   what the app's 「检查更新」 runs: git pull, install, build, restart the server; rebuilds the app
//            when apps/mac changed (prints MAC_APP_REBUILT so the app offers to reopen).
//   build    only compiles the app into build/mac (CI).
//   restart  restarts the background server.
//   uninstall  stops the background server and removes the app (keeps all data).
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LABEL = 'world.aidiscovery.server';
export const APP = 'AI 探索世界.app';
const EXE = 'AIDiscoveryWorld';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const paths = (h = homedir()) => ({
  support: join(h, 'Library', 'Application Support', 'AIDiscoveryWorld'),
  agent: join(h, 'Library', 'LaunchAgents', `${LABEL}.plist`),
  logs: join(h, 'Library', 'Logs', 'AIDiscoveryWorld'),
});

const xml = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
/** A property list from strings, numbers, booleans, arrays and objects. */
export function plist(value) {
  const v = x => typeof x === 'boolean' ? `<${x}/>`
    : typeof x === 'number' ? `<integer>${x}</integer>`
    : Array.isArray(x) ? `<array>${x.map(v).join('')}</array>`
    : x && typeof x === 'object' ? `<dict>${Object.entries(x).map(([k, y]) => `<key>${xml(k)}</key>${v(y)}`).join('')}</dict>`
    : `<string>${xml(x)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${v(value)}</plist>\n`;
}

/** launchd keeps the server running: started at login, restarted 10 s after it stops. */
export function agentPlist({ root, node, env, logs }) {
  return plist({
    Label: LABEL,
    ProgramArguments: [node, join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(root, 'apps', 'server', 'src', 'main.ts')],
    WorkingDirectory: root,
    EnvironmentVariables: env,
    RunAtLoad: true,
    KeepAlive: true,
    ThrottleInterval: 10,
    ProcessType: 'Interactive',
    StandardOutPath: join(logs, 'server.log'),
    StandardErrorPath: join(logs, 'server.log'),
  });
}

export function infoPlist(sourceHash) {
  return plist({
    CFBundleName: 'AI 探索世界', CFBundleDisplayName: 'AI 探索世界', CFBundleIdentifier: 'world.aidiscovery.parent',
    CFBundleExecutable: EXE, CFBundleIconFile: 'AppIcon', CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: '1.0', CFBundleVersion: '1', ADWSourceHash: sourceHash,
    LSMinimumSystemVersion: '12.0', LSApplicationCategoryType: 'public.app-category.education', NSHighResolutionCapable: true,
    NSHumanReadableCopyright: '家庭自用',
    NSAppTransportSecurity: { NSAllowsLocalNetworking: true, NSAllowsArbitraryLoadsInWebContent: true },
  });
}

/** What the server needs from the environment: the PIN, and a PATH that finds git, codex and say. */
export function agentEnv(env, saved = {}) {
  const out = { ...saved };
  for (const [k, v] of Object.entries(env)) if (/^ADW_|^PORT$|^HOST$/.test(k) && v) out[k] = v;
  out.PATH = env.PATH ?? saved.PATH ?? '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin';
  out.HOME = env.HOME ?? saved.HOME;
  out.LANG = 'zh_CN.UTF-8';
  if (!/^\d{4,12}$/.test(out.ADW_PIN ?? '')) throw new Error('需要家长 PIN（4–12 位数字）：请这样运行  ADW_PIN=你的PIN npx -y pnpm@10.28.0 mac-app');
  return out;
}

export const sourceHash = () => createHash('sha256').update(readFileSync(join(root, 'apps', 'mac', 'main.swift'))).update(infoPlist('')).digest('hex').slice(0, 16);

// ---- steps (macOS only) ----

const say = s => console.log(s);
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const quiet = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });
const uid = () => process.getuid();
const port = env => Number(env.PORT ?? 8787);

function needSwift() {
  if (quiet('xcrun', ['--find', 'swiftc']).status === 0) return;
  quiet('xcode-select', ['--install']);
  throw new Error('这台 Mac 还没装苹果的“命令行开发工具”。刚才弹出的窗口里点“安装”（大约几分钟），装好后再运行一次同样的命令。');
}

/** Compiles apps/mac/main.swift into <out>/AI 探索世界.app with an icon, signed for this Mac only. */
export function buildApp(out = join(root, 'build', 'mac')) {
  needSwift();
  const app = join(out, APP), contents = join(app, 'Contents');
  rmSync(app, { recursive: true, force: true });
  mkdirSync(join(contents, 'MacOS'), { recursive: true });
  mkdirSync(join(contents, 'Resources'), { recursive: true });
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  say('· 编译 Mac App…');
  sh('xcrun', ['swiftc', '-O', '-target', `${arch}-apple-macos12.0`, '-o', join(contents, 'MacOS', EXE), join(root, 'apps', 'mac', 'main.swift'), '-framework', 'Cocoa', '-framework', 'WebKit']);
  writeFileSync(join(contents, 'Info.plist'), infoPlist(sourceHash()));
  const set = join(mkdtempSync(join(tmpdir(), 'adw-icon-')), 'AppIcon.iconset');
  mkdirSync(set);
  for (const s of [16, 32, 128, 256, 512]) {
    for (const [scale, suffix] of [[1, ''], [2, '@2x']]) {
      quiet('sips', ['-z', String(s * scale), String(s * scale), join(root, 'apps', 'pad', 'public', 'icon-512.png'), '--out', join(set, `icon_${s}x${s}${suffix}.png`)]);
    }
  }
  quiet('iconutil', ['-c', 'icns', set, '-o', join(contents, 'Resources', 'AppIcon.icns')]);
  quiet('codesign', ['--force', '--sign', '-', app]);
  return app;
}

function installedApp() {
  for (const dir of ['/Applications', join(homedir(), 'Applications')]) if (existsSync(join(dir, APP))) return join(dir, APP);
  return null;
}

function installAppBundle(built) {
  let dir = '/Applications';
  try { accessSync(dir, constants.W_OK); } catch { dir = join(homedir(), 'Applications'); mkdirSync(dir, { recursive: true }); }
  const dest = join(dir, APP);
  rmSync(dest, { recursive: true, force: true });
  sh('ditto', [built, dest]);
  return dest;
}

const installedHash = app => {
  try { return readFileSync(join(app, 'Contents', 'Info.plist'), 'utf8').match(/<key>ADWSourceHash<\/key><string>([^<]*)</)?.[1] ?? null; } catch { return null; }
};

async function hello(p, tries) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/v1/hello`, { signal: AbortSignal.timeout(2000) });
      if (r.ok && (await r.json()).app === 'ai-discovery-world') return true;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

/** (Re)writes the launchd agent and starts it. */
async function startAgent(env) {
  const p = paths();
  mkdirSync(p.logs, { recursive: true });
  mkdirSync(dirname(p.agent), { recursive: true });
  quiet('launchctl', ['bootout', `gui/${uid()}/${LABEL}`]);
  await new Promise(r => setTimeout(r, 2000)); // let the old one exit
  if (await hello(port(env), 1)) {
    say('！终端里还开着旧的服务器：请到那个终端窗口按 Control+C 停掉它，后台服务器会在 10 秒内接上。');
  }
  writeFileSync(p.agent, agentPlist({ root, node: process.execPath, env, logs: p.logs }));
  chmodSync(p.agent, 0o600); // holds the parent PIN
  const r = quiet('launchctl', ['bootstrap', `gui/${uid()}`, p.agent]);
  if (r.status !== 0) quiet('launchctl', ['kickstart', '-k', `gui/${uid()}/${LABEL}`]);
  say('· 等服务器启动…');
  if (!(await hello(port(env), 90))) throw new Error(`服务器 90 秒内没有启动。日志在 ${join(p.logs, 'server.log')}`);
  say(`✓ 服务器在后台运行（开机登录后自动启动）`);
}

function npmInstall() {
  say('· 安装依赖…');
  sh(join(dirname(process.execPath), 'npx'), ['-y', 'pnpm@10.28.0', 'install', '--prefer-offline'], { cwd: root });
}

function buildWeb() {
  say('· 打包家长端和平板页面…');
  sh(process.execPath, [join(root, 'scripts', 'build-apps.mjs')], { cwd: root });
}

function savedEnv() {
  try { return JSON.parse(readFileSync(join(paths().support, 'server-env.json'), 'utf8')); } catch { return {}; }
}

function saveConfig(env) {
  const p = paths();
  mkdirSync(p.support, { recursive: true });
  writeFileSync(join(p.support, 'config.json'), JSON.stringify({ root, node: process.execPath, path: env.PATH, port: port(env) }, null, 2));
  writeFileSync(join(p.support, 'server-env.json'), JSON.stringify(env, null, 2));
  chmodSync(join(p.support, 'server-env.json'), 0o600);
}

async function install() {
  const env = agentEnv(process.env, savedEnv());
  needSwift();
  npmInstall();
  buildWeb();
  saveConfig(env);
  await startAgent(env);
  const app = installAppBundle(buildApp());
  say(`✓ 已安装 ${app}`);
  quiet('open', [app]);
  say('\n以后打开 Dock 或“启动台”里的「AI 探索世界」就行，不用再开终端。更新：App 菜单 → 检查更新。');
}

async function update() {
  const env = agentEnv({}, savedEnv());
  say('· 下载最新版本…');
  sh('git', ['pull', '--ff-only'], { cwd: root });
  npmInstall();
  buildWeb();
  saveConfig(env);
  const app = installedApp();
  if (app && installedHash(app) !== sourceHash()) {
    installAppBundle(buildApp());
    say('MAC_APP_REBUILT');
  }
  await startAgent(env);
  const head = quiet('git', ['-C', root, 'log', '-1', '--format=%h %s']).stdout.trim();
  say(`✓ 现在是最新版本：${head}`);
}

async function main(cmd = 'install') {
  if (process.platform !== 'darwin' && cmd !== 'help') throw new Error('Mac App 只能在 Mac 上安装。');
  if (cmd === 'install') return install();
  if (cmd === 'update') return update();
  if (cmd === 'build') return say(buildApp(process.argv[3] ?? join(root, 'build', 'mac')));
  if (cmd === 'restart') { quiet('launchctl', ['kickstart', '-k', `gui/${uid()}/${LABEL}`]); return say('✓ 已重启服务器'); }
  if (cmd === 'uninstall') {
    quiet('launchctl', ['bootout', `gui/${uid()}/${LABEL}`]);
    rmSync(paths().agent, { force: true });
    const app = installedApp();
    if (app) rmSync(app, { recursive: true, force: true });
    return say('✓ 已停止后台服务器并删除 App。课程和学习记录都还在 data/ 里。');
  }
  throw new Error(`不认识的命令 ${cmd}：install / update / build / restart / uninstall`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv[2]).catch(e => { console.error(`✗ ${e.message}`); process.exit(1); });
}
