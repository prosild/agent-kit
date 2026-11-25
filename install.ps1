# -Tools limits the run to some tools (claude, codex, agy). Use it when one tool is installed as a plugin instead
# (e.g. Claude Code through `claude plugin install`): registering the guard twice for one tool runs it twice per call.
param(
    [string]$HomeDir = '',
    [switch]$Uninstall,
    [string]$Tools = 'claude,codex,agy'
)
$ErrorActionPreference = 'Stop'
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}

$toolSet = @($Tools -split ',' | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ })
$badTools = @($toolSet | Where-Object { $_ -notin @('claude', 'codex', 'agy') })
if (-not $toolSet.Count -or $badTools.Count) {
    Write-Error "-Tools takes a comma-separated list of claude, codex, agy (got: $Tools)"
    exit 2
}
$kitRoot = $PSScriptRoot
$kitRootSlash = $kitRoot -replace '\\', '/'
if ($kitRootSlash -match '[\s&;|<>`"$()''\[\]]') {
    Write-Error "agent-kit path must not contain spaces or shell metacharacters: $kitRootSlash"
    exit 2
}

if (-not $HomeDir) {
    $HomeDir = if ($env:USERPROFILE) { $env:USERPROFILE } elseif ($env:HOME) { $env:HOME } else { [Environment]::GetFolderPath('UserProfile') }
}
if (-not $HomeDir -or -not (Test-Path -LiteralPath $HomeDir)) {
    Write-Error "valid HomeDir not found: $HomeDir"
    exit 2
}
$HomeDir = (Resolve-Path -LiteralPath $HomeDir).Path
$isWinHost = ($env:OS -eq 'Windows_NT') -or ([System.Environment]::OSVersion.Platform -eq 'Win32NT')

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Error "node (Node.js 18+) is required in PATH"
    exit 2
}

function Get-PathItem([string]$Path) {
    try { return Get-Item -LiteralPath $Path -Force -ErrorAction Stop } catch { return $null }
}

function Test-IsReparsePoint([string]$Path) {
    $item = Get-PathItem $Path
    if (-not $item) { return $false }
    return [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
}

function Remove-ReparseLink([string]$Path) {
    $item = Get-PathItem $Path
    if (-not $item) { return $false }
    if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $false }
    if ($isWinHost) {
        & cmd.exe /d /c rmdir "$Path" | Out-Null
        if ($LASTEXITCODE -ne 0 -and (Get-PathItem $Path)) {
            throw "failed to remove junction: $Path"
        }
    } else {
        & rm -f "$Path"
        if ($LASTEXITCODE -ne 0 -and (Get-PathItem $Path)) {
            throw "failed to remove symlink: $Path"
        }
    }
    return $true
}

function Set-SkillLink([string]$TargetDir, [string]$SourceDir) {
    $parent = Split-Path -Parent $TargetDir
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $existingItem = Get-PathItem $TargetDir
    if ($existingItem) {
        if (-not ($existingItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            Write-Warning "skip non-link directory: $TargetDir"
            return 'skipped'
        }
        $existingTarget = $null
        if ($existingItem.PSObject.Properties['Target'] -and $existingItem.Target) {
            $existingTarget = ($existingItem.Target | Select-Object -First 1)
        }
        if ($existingTarget) {
            try {
                $cand = if ([IO.Path]::IsPathRooted($existingTarget)) { $existingTarget } else { Join-Path $parent $existingTarget }
                $r1 = (Resolve-Path -LiteralPath $cand -ErrorAction Stop).Path.TrimEnd('\', '/')
                $r2 = (Resolve-Path -LiteralPath $SourceDir -ErrorAction Stop).Path.TrimEnd('\', '/')
                if ($r1 -eq $r2) { return 'ok' }
            } catch {}
        }
        Remove-ReparseLink $TargetDir | Out-Null
    }
    if ($isWinHost) {
        & cmd.exe /d /c mklink /J "$TargetDir" "$SourceDir" | Out-Null
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $TargetDir)) {
            throw "failed to create junction: $TargetDir -> $SourceDir"
        }
    } else {
        & ln -sfn "$SourceDir" "$TargetDir"
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $TargetDir)) {
            throw "failed to create symlink: $TargetDir -> $SourceDir"
        }
    }
    return 'linked'
}

$skillNames = @('agent-kit-start', 'agent-delegate', 'agent-session-cleanup')
$linkDirs = @()
if ('claude' -in $toolSet) { $linkDirs += (Join-Path (Join-Path $HomeDir '.claude') 'skills') }
if ('codex' -in $toolSet) { $linkDirs += (Join-Path (Join-Path $HomeDir '.agents') 'skills') }
$agySkillsRoot = Join-Path (Join-Path (Join-Path $HomeDir '.gemini') 'config') 'skills'

$skillCount = 0
foreach ($root in $linkDirs) {
    $legacyLink = Join-Path $root 'antigravity-delegate'
    if (Test-IsReparsePoint $legacyLink) {
        Remove-ReparseLink $legacyLink | Out-Null
    }
    foreach ($s in $skillNames) {
        $target = Join-Path $root $s
        $source = Join-Path (Join-Path $kitRoot 'skills') $s
        if ($Uninstall) {
            if (Remove-ReparseLink $target) { $skillCount++ }
        } else {
            $res = Set-SkillLink -TargetDir $target -SourceDir $source
            if ($res -eq 'ok' -or $res -eq 'linked') { $skillCount++ }
        }
    }
}

# Remove legacy Antigravity connector stub files (replaced by native ~/.gemini/config/skills.json)
foreach ($legacyName in $(if ('agy' -in $toolSet) { $skillNames + @('antigravity-delegate') } else { @() })) {
    $legacyAgyDir = Join-Path $agySkillsRoot $legacyName
    $legacyAgyFile = Join-Path $legacyAgyDir 'SKILL.md'
    if (Test-Path -LiteralPath $legacyAgyFile) {
        $rawLegacy = [IO.File]::ReadAllText($legacyAgyFile, [Text.Encoding]::UTF8)
        if ($rawLegacy -match 'agent-kit') {
            Remove-Item -LiteralPath $legacyAgyFile -Force
            if ((Get-ChildItem -LiteralPath $legacyAgyDir -Force | Measure-Object).Count -eq 0) {
                Remove-Item -LiteralPath $legacyAgyDir -Force
            }
        }
    }
}

$nodeScript = @'
const fs = require('fs');
const path = require('path');

const homeDir = process.env.AGENTKIT_INSTALL_HOME;
const kitRootSlash = process.env.AGENTKIT_INSTALL_ROOT;
const mode = process.env.AGENTKIT_INSTALL_MODE;
const uninstall = mode === 'uninstall';
const tools = new Set(String(process.env.AGENTKIT_INSTALL_TOOLS || 'claude,codex,agy').split(','));
const guardCmd = `node ${kitRootSlash}/hooks/guard.mjs`;
const agySkillsEntry = `${kitRootSlash}/skills`;
const isGuardCmd = (c) => typeof c === 'string' && (c.includes('/hooks/guard.mjs') || c.includes('\\hooks\\guard.mjs'));
const isKitSkillsPath = (p) => typeof p === 'string' && (
  p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === agySkillsEntry.toLowerCase() ||
  /\/agent-kit\/skills\/?$/i.test(p.replace(/\\/g, '/'))
);
const LEGACY_CLAUDE_MATCHER = 'Read|Edit|Write|NotebookEdit|Grep|Glob|Bash|PowerShell';

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function writeJsonIfChanged(filePath, obj) {
  const next = JSON.stringify(obj, null, 2) + '\n';
  if (fs.existsSync(filePath)) {
    const cur = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    if (cur === next) return false;
  } else {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  fs.writeFileSync(filePath, next, 'utf8');
  return true;
}

function updatePreToolUseList(list, defaultGroup, upgradeClaudeMatcher = false) {
  if (!Array.isArray(list)) list = [];
  if (uninstall) {
    const filtered = [];
    for (const grp of list) {
      if (!grp || !Array.isArray(grp.hooks)) {
        filtered.push(grp);
        continue;
      }
      const nextHooks = grp.hooks.filter((h) => !h || !isGuardCmd(h.command));
      if (nextHooks.length > 0) {
        filtered.push({ ...grp, hooks: nextHooks });
      }
    }
    return filtered;
  }
  let found = false;
  for (const grp of list) {
    if (!grp || !Array.isArray(grp.hooks)) continue;
    for (const h of grp.hooks) {
      if (h && isGuardCmd(h.command)) {
        h.command = guardCmd;
        if (!h.type) h.type = 'command';
        if (!h.timeout) h.timeout = 10;
        if (upgradeClaudeMatcher && grp.matcher === LEGACY_CLAUDE_MATCHER) {
          grp.matcher = '.*';
        }
        found = true;
      }
    }
  }
  if (!found) {
    list.push(defaultGroup);
  }
  return list;
}

let updatedHooks = 0;
let agySkillsCount = 0;

// 1. Claude: ~/.claude/settings.json
const claudePath = path.join(homeDir, '.claude', 'settings.json');
if (tools.has('claude') && (!uninstall || fs.existsSync(claudePath))) {
  const claudeObj = readJson(claudePath) || {};
  if (!uninstall && claudeObj.cleanupPeriodDays === undefined) {
    claudeObj.cleanupPeriodDays = 36500;
  }
  if (!claudeObj.hooks || typeof claudeObj.hooks !== 'object') {
    claudeObj.hooks = {};
  }
  const claudeDefault = {
    matcher: '.*',
    hooks: [{ type: 'command', command: guardCmd, timeout: 10, statusMessage: 'guard 검사' }]
  };
  claudeObj.hooks.PreToolUse = updatePreToolUseList(claudeObj.hooks.PreToolUse, claudeDefault, true);
  if (uninstall && claudeObj.hooks.PreToolUse.length === 0) {
    delete claudeObj.hooks.PreToolUse;
    if (Object.keys(claudeObj.hooks).length === 0) delete claudeObj.hooks;
  }
  writeJsonIfChanged(claudePath, claudeObj);
  updatedHooks++;
}

// 2. Codex: ~/.codex/hooks.json
const codexPath = path.join(homeDir, '.codex', 'hooks.json');
if (tools.has('codex') && (!uninstall || fs.existsSync(codexPath))) {
  const codexObj = readJson(codexPath) || {};
  if (!codexObj.hooks || typeof codexObj.hooks !== 'object') {
    codexObj.hooks = {};
  }
  const codexDefault = {
    hooks: [{ type: 'command', command: guardCmd, timeout: 10 }]
  };
  codexObj.hooks.PreToolUse = updatePreToolUseList(codexObj.hooks.PreToolUse, codexDefault, false);
  if (uninstall && codexObj.hooks.PreToolUse.length === 0) {
    delete codexObj.hooks.PreToolUse;
    if (Object.keys(codexObj.hooks).length === 0) delete codexObj.hooks;
  }
  writeJsonIfChanged(codexPath, codexObj);
  updatedHooks++;
}

// 3. Antigravity: ~/.gemini/config/hooks.json & ~/.gemini/config/skills.json
const agyPath = path.join(homeDir, '.gemini', 'config', 'hooks.json');
if (tools.has('agy') && (!uninstall || fs.existsSync(agyPath))) {
  const agyObj = readJson(agyPath) || {};
  if (uninstall) {
    delete agyObj['agent-kit-guard'];
  } else {
    agyObj['agent-kit-guard'] = {
      PreToolUse: [
        {
          matcher: '.*',
          hooks: [{ type: 'command', command: guardCmd, timeout: 10 }]
        }
      ]
    };
  }
  writeJsonIfChanged(agyPath, agyObj);
  updatedHooks++;
}

const agySkillsJsonPath = path.join(homeDir, '.gemini', 'config', 'skills.json');
if (tools.has('agy') && (!uninstall || fs.existsSync(agySkillsJsonPath))) {
  const skillsObj = readJson(agySkillsJsonPath) || {};
  const entries = Array.isArray(skillsObj.entries) ? skillsObj.entries : [];
  if (uninstall) {
    const beforeLen = entries.length;
    skillsObj.entries = entries.filter((e) => !e || !isKitSkillsPath(e.path));
    if (skillsObj.entries.length < beforeLen) agySkillsCount = 3;
    if (skillsObj.entries.length === 0 && !skillsObj.inherits) {
      if (fs.existsSync(agySkillsJsonPath)) fs.unlinkSync(agySkillsJsonPath);
    } else {
      writeJsonIfChanged(agySkillsJsonPath, skillsObj);
    }
  } else {
    let matched = false;
    for (const e of entries) {
      if (e && isKitSkillsPath(e.path)) {
        e.path = agySkillsEntry;
        matched = true;
      }
    }
    if (!matched) {
      entries.push({ path: agySkillsEntry });
    }
    skillsObj.entries = entries;
    writeJsonIfChanged(agySkillsJsonPath, skillsObj);
    agySkillsCount = 3;
  }
}

process.stdout.write(JSON.stringify({ hooks: updatedHooks, agySkills: agySkillsCount }));
'@

$modeArg = if ($Uninstall) { 'uninstall' } else { 'install' }
$env:AGENTKIT_INSTALL_HOME = $HomeDir
$env:AGENTKIT_INSTALL_ROOT = $kitRootSlash
$env:AGENTKIT_INSTALL_MODE = $modeArg
$env:AGENTKIT_INSTALL_TOOLS = ($toolSet -join ',')
$nodeOut = & node -e $nodeScript
Remove-Item Env:\AGENTKIT_INSTALL_HOME, Env:\AGENTKIT_INSTALL_ROOT, Env:\AGENTKIT_INSTALL_MODE, Env:\AGENTKIT_INSTALL_TOOLS -ErrorAction SilentlyContinue
if ($LASTEXITCODE -ne 0) {
    Write-Error "failed to configure hook/skill JSON files"
    exit 1
}
$parsed = $nodeOut | ConvertFrom-Json
$hookCount = [int]$parsed.hooks
$skillCount += [int]$parsed.agySkills

if ($Uninstall) {
    Write-Output "UNINSTALL: OK (skills=$skillCount, hooks=$hookCount)"
    exit 0
}

$guardScript = Join-Path (Join-Path $kitRoot 'hooks') 'guard.mjs'
$probeJson = '{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":".env"}}'
$probeOut = $probeJson | & node $guardScript
if ($LASTEXITCODE -ne 0 -or $probeOut -notmatch '"permissionDecision"\s*:\s*"deny"') {
    Write-Error "guard.mjs self-test failed: $probeOut"
    exit 1
}

Write-Output "INSTALL: OK (path=$kitRootSlash, skills=$skillCount, hooks=$hookCount, guard=PASS)"
if ('codex' -in $toolSet) { Write-Output 'NEXT: Codex runs a new or changed hook only after you trust it. Open Codex and check /hooks once.' }
if ('claude' -in $toolSet) { Write-Output 'NOTE: Claude Code can load this folder as a plugin instead (claude plugin install agent-kit@agent-kit). Use one way per tool: with the plugin installed, run install.ps1 -Tools codex,agy.' }
