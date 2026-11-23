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
  // 1. Pre-populate existing user settings and unresolved <agent-kit> hook to test safe merge & repair
  const claudeDir = path.join(tmpHome, '.claude');
  const codexDir = path.join(tmpHome, '.codex');
  const agyConfigDir = path.join(tmpHome, '.gemini', 'config');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  fs.mkdirSync(agyConfigDir, { recursive: true });

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
          matcher: '.*',
          hooks: [{ type: 'command', command: 'node <agent-kit>/hooks/guard.mjs', timeout: 10 }]
        }
      ]
    }
  }, null, 2), 'utf8');

  fs.writeFileSync(path.join(agyConfigDir, 'hooks.json'), JSON.stringify({
    'other-plugin': { PreToolUse: [] }
  }, null, 2), 'utf8');

  // 2. Run install.ps1 against isolated HomeDir
  const res1 = runPs1(installPs1, ['-HomeDir', tmpHome]);
  assert.equal(res1.status, 0, `install.ps1 failed: ${res1.stderr}\n${res1.stdout}`);
  assert.match(res1.stdout, /INSTALL: OK \(path=.*, skills=9, hooks=3, guard=PASS\)/);

  // 3. Verify 3 skills linked in ~/.claude/skills, ~/.agents/skills, and connector files in ~/.gemini/config/skills
  const skills = ['agent-kit-start', 'agent-delegate', 'agent-session-cleanup'];
  for (const s of skills) {
    const claudeSkill = path.join(tmpHome, '.claude', 'skills', s, 'SKILL.md');
    const codexSkill = path.join(tmpHome, '.agents', 'skills', s, 'SKILL.md');
    const agySkill = path.join(tmpHome, '.gemini', 'config', 'skills', s, 'SKILL.md');
    assert.ok(fs.existsSync(claudeSkill), `missing claude skill: ${claudeSkill}`);
    assert.ok(fs.existsSync(codexSkill), `missing codex skill: ${codexSkill}`);
    assert.ok(fs.existsSync(agySkill), `missing agy skill: ${agySkill}`);

    const agyStat = fs.lstatSync(path.join(tmpHome, '.gemini', 'config', 'skills', s));
    assert.equal(agyStat.isSymbolicLink(), false, 'AGY skill dir must be a real directory, not a junction/symlink');
    const agyText = fs.readFileSync(agySkill, 'utf8');
    assert.ok(!agyText.includes('<agent-kit>'), 'AGY connector must have resolved <agent-kit>');
    assert.ok(agyText.includes(`skills/${s}/SKILL.md`), 'AGY connector must point to kit skill path');
  }

  // 4. Verify hooks JSON files merged cleanly and preserved user settings
  const claudeSettings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
  assert.equal(claudeSettings.model, 'opus');
  assert.equal(claudeSettings.language, 'korean');
  assert.equal(claudeSettings.cleanupPeriodDays, 36500);
  assert.equal(claudeSettings.hooks.PreToolUse.length, 2, 'Should preserve custom hook and update existing guard hook in-place');
  assert.equal(claudeSettings.hooks.PreToolUse[0].hooks[0].command, 'echo custom-hook');
  assert.ok(!claudeSettings.hooks.PreToolUse[1].hooks[0].command.includes('<agent-kit>'));
  assert.ok(claudeSettings.hooks.PreToolUse[1].hooks[0].command.endsWith('/hooks/guard.mjs'));

  const codexHooks = JSON.parse(fs.readFileSync(path.join(codexDir, 'hooks.json'), 'utf8'));
  assert.equal(codexHooks.hooks.PreToolUse.length, 1);
  assert.ok(codexHooks.hooks.PreToolUse[0].hooks[0].command.endsWith('/hooks/guard.mjs'));

  const agyHooks = JSON.parse(fs.readFileSync(path.join(agyConfigDir, 'hooks.json'), 'utf8'));
  assert.ok(agyHooks['other-plugin'], 'Should preserve other-plugin in AGY hooks.json');
  assert.ok(agyHooks['agent-kit-guard'].PreToolUse[0].hooks[0].command.endsWith('/hooks/guard.mjs'));

  // 5. Verify check-tools.ps1 reports no hook warnings on this installed HomeDir
  const chk = runPs1(checkToolsPs1, [], { USERPROFILE: tmpHome, HOME: tmpHome });
  assert.equal(chk.status, 0);
  assert.ok(!chk.stdout.includes('[hooks: WARN'), `Expected no hook warnings, got: ${chk.stdout}`);

  // 6. Verify idempotency (second run succeeds without duplicating hooks)
  const res2 = runPs1(installPs1, ['-HomeDir', tmpHome]);
  assert.equal(res2.status, 0);
  const claudeSettingsAfter = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
  assert.equal(claudeSettingsAfter.hooks.PreToolUse.length, 2);

  // 7. Verify -Uninstall removes only agent-kit links and guard hooks while preserving user settings and original skill files
  const resUn = runPs1(installPs1, ['-HomeDir', tmpHome, '-Uninstall']);
  assert.equal(resUn.status, 0, `uninstall failed: ${resUn.stderr}`);
  assert.match(resUn.stdout, /UNINSTALL: OK/);

  for (const s of skills) {
    assert.ok(!fs.existsSync(path.join(tmpHome, '.claude', 'skills', s)));
    assert.ok(!fs.existsSync(path.join(tmpHome, '.agents', 'skills', s)));
    assert.ok(!fs.existsSync(path.join(tmpHome, '.gemini', 'config', 'skills', s, 'SKILL.md')));
    // Original kit skill must still exist untouched!
    assert.ok(fs.existsSync(path.join(__dirname, 'skills', s, 'SKILL.md')), `Original skill was deleted: ${s}`);
  }

  const claudeUn = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
  assert.equal(claudeUn.model, 'opus');
  assert.equal(claudeUn.hooks.PreToolUse.length, 1, 'Custom hook must remain after uninstall');
  assert.equal(claudeUn.hooks.PreToolUse[0].hooks[0].command, 'echo custom-hook');

  const agyUn = JSON.parse(fs.readFileSync(path.join(agyConfigDir, 'hooks.json'), 'utf8'));
  assert.ok(agyUn['other-plugin']);
  assert.equal(agyUn['agent-kit-guard'], undefined);

  console.log('ALL PASS');
} finally {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}
