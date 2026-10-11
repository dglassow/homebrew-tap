import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readlink, realpath, rm, symlink, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

// Exercise Homebrew's serialized artifacts, not the recipe's source text.
const tapRoot = execFileSync('brew', ['--repository', 'dglassow/tap'], { encoding: 'utf8' }).trim();
const recipe = join(tapRoot, 'Casks', 'glass.rb');
const metadata = JSON.parse(execFileSync('brew', ['info', '--cask', '--json=v2', recipe], { encoding: 'utf8' })).casks[0];
const lifecycle = metadata.artifacts.find(item => item.generated_script).generated_script[1].content;
const guard = metadata.artifacts.find(item => item.preflight_steps).preflight_steps[0].steps[0].args[1];
const labels = ['com.glassow.glass.backend', 'com.glassow.glass.computer'];
const escaped = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const plist = (label, args) => `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${escaped(label)}</string><key>ProgramArguments</key><array>${args.map(arg => `<string>${escaped(arg)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>`;
const exists = async path => access(path).then(() => true, () => false);
const launchctl = (...args) => spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
const domain = label => `gui/${process.getuid()}/${label}`;

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'glass-brew-lifecycle-')));
  const home = join(root, 'home'), appdir = join(root, 'Applications'), room = join(root, 'Caskroom');
  const service = join(home, '.glass', 'service'), agents = join(home, 'Library', 'LaunchAgents');
  const app = join(appdir, 'Glass.app'), info = join(app, 'Contents', 'Info.plist');
  await Promise.all([mkdir(service, { recursive: true }), mkdir(agents, { recursive: true }), mkdir(dirname(info), { recursive: true }), mkdir(join(home, '.local', 'bin'), { recursive: true }), mkdir(room)]);
  await writeFile(info, '<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>0.3.4</string></dict></plist>');
  await writeFile(join(home, '.glass', 'private-state'), 'retained-owner-state');
  const helper = join(root, 'lifecycle.rb');
  await writeFile(helper, lifecycle);
  const brew = join(root, 'brew');
  await writeFile(brew, `#!/usr/bin/env node\nrequire('node:fs').rmSync(process.env.GLASS_TEST_APP, {recursive:true,force:true});\n`, { mode: 0o755 });
  const shim = join(root, 'launchctl-isolation.rb');
  // Keep tests independent of the developer's live launchd namespace. No test
  // can execute a real bootout; the separate fresh-domain smoke below can.
  await writeFile(shim, `require 'open3'\nmodule Open3\n  class << self\n    alias glass_real_capture3 capture3\n    def capture3(*args)\n      if args[0] == '/bin/launchctl'\n        status = Struct.new(:ok) { def success?; ok; end }.new(ENV['GLASS_TEST_FOREIGN_SERVICE'] == '1')\n        return ["path = /unrelated/LaunchAgents/foreign.plist\\n", '', status]\n      end\n      glass_real_capture3(*args)\n    end\n  end\nend\nmodule Kernel\n  alias glass_real_system system\n  def system(*args)\n    raise 'Test attempted live launchctl' if args[0] == '/bin/launchctl'\n    glass_real_system(*args)\n  end\nend\n`);
  const backendArgs = [join(service, 'node'), join(service, 'glassd.mjs'), '--service-dir', service, '--config', join(service, 'config.json'), '--control', join(service, 'control.sock'), '--controller-id', 'a'.repeat(64)];
  const backendPlist = join(agents, `${labels[0]}.plist`), computerPlist = join(agents, `${labels[1]}.plist`);
  await writeFile(backendPlist, plist(labels[0], backendArgs));
  await writeFile(computerPlist, plist(labels[1], ['/usr/bin/open', '-gj', app]));
  await symlink(join(service, 'glass'), join(home, '.local', 'bin', 'glass'));
  await symlink(join(app, 'Contents', 'MacOS', 'glass-desktop'), join(home, '.local', 'bin', 'glassctl'));
  const env = { ...process.env, HOME: home, GLASS_TEST_APP: app, RUBYOPT: `-r${shim}` };
  const clean = () => spawnSync('/usr/bin/ruby', [helper, 'uninstall', appdir, brew], { env, encoding: 'utf8' });
  return { root, home, appdir, room, service, agents, app, info, helper, brew, env, backendPlist, computerPlist, clean };
}

test('upgrade guard refuses newer installed and backed-up bundles, permits equal/newer targets', async () => {
  const f = await fixture();
  try {
    const run = version => spawnSync('/usr/bin/ruby', ['-e', guard, f.appdir, f.room, version], { encoding: 'utf8' }).status;
    assert.deepEqual(['0.3.3', '0.3.4', '0.3.5'].map(run), [1, 0, 0]);
    const backupInfo = join(f.room, '0.3.2.upgrading', 'Glass.app', 'Contents', 'Info.plist');
    await mkdir(dirname(backupInfo), { recursive: true });
    await writeFile(backupInfo, await readFile(f.info));
    await rm(f.app, { recursive: true });
    assert.deepEqual(['0.3.3', '0.3.4', '0.3.5'].map(run), [1, 0, 0]);
    assert.match(await readFile(backupInfo, 'utf8'), /0\.3\.4/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('explicit cleanup removes unregistered owned files and app, retains private data and foreign links', async () => {
  const f = await fixture();
  try {
    const foreignLink = join(f.home, '.local', 'bin', 'glassctl');
    await rm(foreignLink);
    await symlink(join(f.root, 'unrelated-command'), foreignLink);
    const result = f.clean();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await exists(f.backendPlist), false);
    assert.equal(await exists(f.computerPlist), false);
    assert.equal(await exists(f.app), false);
    assert.equal(await readFile(join(f.home, '.glass', 'private-state'), 'utf8'), 'retained-owner-state');
    assert.equal(await readlink(foreignLink), join(f.root, 'unrelated-command'));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('foreign launch agent contents and regular CLI files are retained', async () => {
  const f = await fixture();
  try {
    const foreign = plist(labels[0], ['/bin/sleep', '60']);
    await writeFile(f.backendPlist, foreign);
    const command = join(f.home, '.local', 'bin', 'glass');
    await rm(command);
    await writeFile(command, 'unrelated-command');
    assert.equal(f.clean().status, 0);
    assert.equal(await readFile(f.backendPlist, 'utf8'), foreign);
    assert.equal(await readFile(command, 'utf8'), 'unrelated-command');
    assert.equal(await readFile(join(f.home, '.glass', 'private-state'), 'utf8'), 'retained-owner-state');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('a loaded label from another registration refuses cleanup without deleting any owned files', async () => {
  const f = await fixture();
  try {
    f.env.GLASS_TEST_FOREIGN_SERVICE = '1';
    assert.equal(f.clean().status, 1);
    assert.equal(await exists(f.backendPlist), true);
    assert.equal(await exists(f.computerPlist), true);
    assert.equal(await exists(f.app), true);
    assert.equal(await readFile(join(f.home, '.glass', 'private-state'), 'utf8'), 'retained-owner-state');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('fresh launchd domain: explicit cleanup stops only the fixture backend and preserves data', async t => {
  if (labels.some(label => launchctl('print', domain(label)).status === 0)) {
    t.skip('Glass services already occupy this user domain; do not touch the live fleet');
    return;
  }
  if (launchctl('print', `gui/${process.getuid()}`).status !== 0) {
    t.skip('No GUI launchd domain on this runner');
    return;
  }
  const f = await fixture();
  let registered = false;
  try {
    await symlink(process.execPath, join(f.service, 'node'));
    await writeFile(join(f.service, 'glassd.mjs'), 'setInterval(() => {}, 1000);\n');
    const bootstrap = launchctl('bootstrap', `gui/${process.getuid()}`, f.backendPlist);
    assert.equal(bootstrap.status, 0, bootstrap.stderr);
    registered = true;
    assert.equal(launchctl('print', domain(labels[0])).status, 0);
    delete f.env.RUBYOPT;
    assert.equal(f.clean().status, 0);
    assert.notEqual(launchctl('print', domain(labels[0])).status, 0);
    registered = false;
    assert.equal(await exists(f.app), false);
    assert.equal(await exists(f.backendPlist), false);
    assert.equal(await readFile(join(f.home, '.glass', 'private-state'), 'utf8'), 'retained-owner-state');
  } finally {
    if (registered) {
      const current = launchctl('print', domain(labels[0]));
      assert.match(current.stdout, new RegExp(f.backendPlist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      launchctl('bootout', domain(labels[0]));
    }
    await rm(f.root, { recursive: true, force: true });
  }
});
