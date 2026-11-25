import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const installPs1 = path.join(__dirname, 'install.ps1');
const checkToolsPs1 = path.join(__dirname, 'check-tools.ps1');
const pwshBin = process.platform === 'win32' ? 'powershell' : 'pwsh';
const pwshArgs = process.platform === 'win32'
  ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File']
  : ['-NoProfile', '-File'];

function runPs1(script, args = [], env = {}) {
  return spawnSync(pwshBin, [...pwshArgs, script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
}

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentkit-install-test-'));
try {
  // 1. Pre-populate existing user settings, legacy narrow Claude matcher, unresolved <agent-kit> hook, and legacy AGY stub skill
  const claudeDir = path.join(tmpHome, '.claude');
  const codexDir = path.join(tmpHome, '.codex');
  const agyConfigDir = path.join(tmpHome, '.gemini', 'config');
  const legacyAgyStubDir = path.join(agyConfigDir, 'skills', 'agent-delegate');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  fs.mkdirSync(legacyAgyStubDir, { recursive: true });

  fs.writeFileSync(path.join(legacyAgyStubDir, 'SKILL.md'), '---\nname: agent-delegate\n---\n원본은 agent-kit에 있다.\n', 'utf8');

  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
    model: 'opus',
    language: 'korean',
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: 'echo custom-hook', timeout: 5 }]
        },
        {
          matcher: 'Read|Edit|Write|NotebookEdit|Grep|Glob|Bash|PowerShell',
          hooks: [{ type: 'command', command: 'node <agent-kit>/hooks/guard.mjs', timeout: 10 }]
        }
      ]
    }
  }, null, 2), 'utf8');

  fs.writeFileSync(path.join(agyConfigDir, 'hooks.json'), JSON.stringify({
    'other-plugin': { PreToolUse: [] }
  }, null, 2), 'utf8');

  fs.writeFileSync(path.join(agyConfigDir, 'skills.json'), JSON.stringify({
    entries: [{ path: '~/my-other-skills' }]
  }, null, 2), 'utf8');

  // 2. Run install.ps1 against isolated HomeDir
  const res1 = runPs1(installPs1, ['-HomeDir', tmpHome]);
  assert.equal(res1.status, 0, `install.ps1 failed: ${res1.stderr}\n${res1.stdout}`);
  assert.match(res1.stdout, /INSTALL: OK \(path=.*, skills=9, hooks=3, guard=PASS\)/);

  // 3. Verify skills linked in ~/.claude/skills & ~/.agents/skills, legacy AGY stub removed, and native skills.json registered
  const skills = ['agent-kit-start', 'agent-delegate', 'agent-session-cleanup'];
  for (const s of skills) {
    const claudeSkill = path.join(tmpHome, '.claude', 'skills', s, 'SKILL.md');
    const codexSkill = path.join(tmpHome, '.agents', 'skills', s, 'SKILL.md');
    assert.ok(fs.existsSync(claudeSkill), `missing claude skill: ${claudeSkill}`);
    assert.ok(fs.existsSync(codexSkill), `missing codex skill: ${codexSkill}`);
    assert.ok(!fs.existsSync(path.join(agyConfigDir, 'skills', s, 'SKILL.md')), `legacy AGY stub should be removed: ${s}`);
  }

  const agySkillsManifest = JSON.parse(fs.readFileSync(path.join(agyConfigDir, 'skills.json'), 'utf8'));
  assert.equal(agySkillsManifest.entries.length, 2, 'Should preserve existing skills.json entry and add agent-kit/skills');
  assert.equal(agySkillsManifest.entries[0].path, '~/my-other-skills');
  assert.ok(agySkillsManifest.entries[1].path.endsWith('/skills') && !agySkillsManifest.entries[1].path.includes('<agent-kit>'));

  // 4. Verify hooks JSON files merged cleanly, upgraded Claude matcher to '.*', and preserved user settings
  const claudeSettings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
  assert.equal(claudeSettings.model, 'opus');
  assert.equal(claudeSettings.language, 'korean');
  assert.equal(claudeSettings.cleanupPeriodDays, 36500);
  assert.equal(claudeSettings.hooks.PreToolUse.length, 2);
  assert.equal(claudeSettings.hooks.PreToolUse[0].hooks[0].command, 'echo custom-hook');
  assert.equal(claudeSettings.hooks.PreToolUse[1].matcher, '.*', 'Legacy narrow Claude matcher should be upgraded to .*');
  assert.ok(!claudeSettings.hooks.PreToolUse[1].hooks[0].command.includes('<agent-kit>'));
  assert.ok(claudeSettings.hooks.PreToolUse[1].hooks[0].command.endsWith('/hooks/guard.mjs'));

  const codexHooks = JSON.parse(fs.readFileSync(path.join(codexDir, 'hooks.json'), 'utf8'));
  assert.equal(codexHooks.hooks.PreToolUse.length, 1);
  assert.ok(codexHooks.hooks.PreToolUse[0].hooks[0].command.endsWith('/hooks/guard.mjs'));

  const agyHooks = JSON.parse(fs.readFileSync(path.join(agyConfigDir, 'hooks.json'), 'utf8'));
  assert.ok(agyHooks['other-plugin'], 'Should preserve other-plugin in AGY hooks.json');
  assert.ok(agyHooks['agent-kit-guard'].PreToolUse[0].hooks[0].command.endsWith('/hooks/guard.mjs'));

  // 5. Verify check-tools.ps1 reports no hook warnings on this installed HomeDir
  const chk = runPs1(checkToolsPs1, [], { USERPROFILE: tmpHome, HOME: tmpHome, AGENTKIT_HOME: tmpHome });
  assert.equal(chk.status, 0);
  assert.ok(!chk.stdout.includes('[hooks: WARN'), `Expected no hook warnings, got: ${chk.stdout}`);

  // 6. Verify idempotency
  const res2 = runPs1(installPs1, ['-HomeDir', tmpHome]);
  assert.equal(res2.status, 0);
  const agySkillsAfter = JSON.parse(fs.readFileSync(path.join(agyConfigDir, 'skills.json'), 'utf8'));
  assert.equal(agySkillsAfter.entries.length, 2);

  // 7. Verify -Uninstall removes only agent-kit links, skills.json entry, and guard hooks while preserving user settings
  const resUn = runPs1(installPs1, ['-HomeDir', tmpHome, '-Uninstall']);
  assert.equal(resUn.status, 0, `uninstall failed: ${resUn.stderr}`);
  assert.match(resUn.stdout, /UNINSTALL: OK/);

  for (const s of skills) {
    assert.ok(!fs.existsSync(path.join(tmpHome, '.claude', 'skills', s)));
    assert.ok(!fs.existsSync(path.join(tmpHome, '.agents', 'skills', s)));
    assert.ok(fs.existsSync(path.join(__dirname, 'skills', s, 'SKILL.md')), `Original skill was deleted: ${s}`);
  }

  const agySkillsUn = JSON.parse(fs.readFileSync(path.join(agyConfigDir, 'skills.json'), 'utf8'));
  assert.equal(agySkillsUn.entries.length, 1);
  assert.equal(agySkillsUn.entries[0].path, '~/my-other-skills');

  const claudeUn = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
  assert.equal(claudeUn.model, 'opus');
  assert.equal(claudeUn.hooks.PreToolUse.length, 1, 'Custom hook must remain after uninstall');
  assert.equal(claudeUn.hooks.PreToolUse[0].hooks[0].command, 'echo custom-hook');

  const agyUn = JSON.parse(fs.readFileSync(path.join(agyConfigDir, 'hooks.json'), 'utf8'));
  assert.ok(agyUn['other-plugin']);
  assert.equal(agyUn['agent-kit-guard'], undefined);

  // 8. -Tools limits the run: with Claude Code installed as a plugin, only Codex and Antigravity are linked here
  const partHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentkit-install-part-'));
  try {
    const resPart = runPs1(installPs1, ['-HomeDir', partHome, '-Tools', 'codex,agy']);
    assert.equal(resPart.status, 0, `install -Tools failed: ${resPart.stderr}\n${resPart.stdout}`);
    assert.match(resPart.stdout, /INSTALL: OK \(path=.*, skills=6, hooks=2, guard=PASS\)/);
    assert.ok(!fs.existsSync(path.join(partHome, '.claude', 'settings.json')), '-Tools codex,agy must not touch Claude settings');
    assert.ok(!fs.existsSync(path.join(partHome, '.claude', 'skills')), '-Tools codex,agy must not link Claude skills');
    assert.ok(fs.existsSync(path.join(partHome, '.agents', 'skills', 'agent-delegate', 'SKILL.md')));
    assert.ok(JSON.parse(fs.readFileSync(path.join(partHome, '.codex', 'hooks.json'), 'utf8')).hooks.PreToolUse.length === 1);
    assert.ok(JSON.parse(fs.readFileSync(path.join(partHome, '.gemini', 'config', 'hooks.json'), 'utf8'))['agent-kit-guard']);
    const resBad = runPs1(installPs1, ['-HomeDir', partHome, '-Tools', 'claude,cursor']);
    assert.notEqual(resBad.status, 0, 'unknown tool name must fail');
    const resPartUn = runPs1(installPs1, ['-HomeDir', partHome, '-Tools', 'codex,agy', '-Uninstall']);
    assert.equal(resPartUn.status, 0, `uninstall -Tools failed: ${resPartUn.stderr}`);
    assert.ok(!fs.existsSync(path.join(partHome, '.agents', 'skills', 'agent-delegate')));
  } finally {
    fs.rmSync(partHome, { recursive: true, force: true });
  }

  // 9. Plugin manifests: one repository serves as a plugin for the three tools (each tool reads its own files)
  const readJ = (rel) => JSON.parse(fs.readFileSync(path.join(__dirname, rel), 'utf8'));
  const claudePlugin = readJ('.claude-plugin/plugin.json');
  const claudeMarket = readJ('.claude-plugin/marketplace.json');
  assert.equal(claudePlugin.name, 'agent-kit');
  assert.ok(claudeMarket.owner && claudeMarket.owner.name, 'Claude marketplace needs owner.name');
  assert.deepEqual(claudeMarket.plugins.map((p) => [p.name, p.source]), [['agent-kit', './']]);
  const sharedHooks = readJ('hooks/hooks.json').hooks.PreToolUse;
  assert.equal(sharedHooks.length, 1);
  assert.equal(sharedHooks[0].matcher, '.*');
  assert.equal(sharedHooks[0].hooks[0].command, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/guard.mjs"');
  const codexPlugin = readJ('.codex-plugin/plugin.json');
  const codexMarket = readJ('.agents/plugins/marketplace.json');
  assert.equal(codexPlugin.name, 'agent-kit');
  assert.equal(codexPlugin.skills, './skills/');
  assert.equal(codexMarket.plugins[0].name, 'agent-kit');
  assert.ok(codexMarket.plugins[0].policy.installation && codexMarket.plugins[0].category, 'Codex catalog entries need policy and category');
  const agyPlugin = readJ('.antigravity-plugin/plugin.json');
  const agyPluginHooks = readJ('hooks.json')['agent-kit-guard'];
  assert.equal(agyPlugin.name, 'agent-kit');
  assert.equal(agyPluginHooks.enabled, true);
  assert.equal(agyPluginHooks.PreToolUse[0].hooks[0].command, 'node ./hooks/guard.mjs', 'Antigravity runs plugin hooks from the plugin root');
  assert.equal(new Set([claudePlugin.version, codexPlugin.version, agyPlugin.version]).size, 1, 'the three manifests carry the same version');
  for (const s of skills) {
    const front = fs.readFileSync(path.join(__dirname, 'skills', s, 'SKILL.md'), 'utf8').split('\n').slice(0, 4).join('\n');
    assert.match(front, new RegExp(`^name: ${s}$`, 'm'), `skill folder and name must match: ${s}`);
  }

  console.log('ALL PASS');
} finally {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}
