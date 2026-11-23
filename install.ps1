param(
    [string]$HomeDir = '',
    [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}

$kitRoot = $PSScriptRoot
$kitRootSlash = $kitRoot -replace '\\', '/'
if ($kitRootSlash -match '[\s&;|<>`"$()\[\]]') {
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

function Test-IsReparsePoint([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    try {
        $item = Get-Item -LiteralPath $Path -Force
        return [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
    } catch {
        return $false
    }
}

function Remove-ReparseLink([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    if (-not (Test-IsReparsePoint $Path)) { return $false }
    if ($isWinHost) {
        & cmd.exe /d /c rmdir "$Path" | Out-Null
        if ($LASTEXITCODE -ne 0 -and (Test-Path -LiteralPath $Path)) {
            throw "failed to remove junction: $Path"
        }
    } else {
        & rm -f "$Path"
        if ($LASTEXITCODE -ne 0 -and (Test-Path -LiteralPath $Path)) {
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
    if (Test-Path -LiteralPath $TargetDir) {
        if (-not (Test-IsReparsePoint $TargetDir)) {
            Write-Warning "skip non-link directory: $TargetDir"
            return 'skipped'
        }
        $item = Get-Item -LiteralPath $TargetDir -Force
        $existingTarget = $null
        if ($item.PSObject.Properties['Target'] -and $item.Target) {
            $existingTarget = ($item.Target | Select-Object -First 1)
        }
        if ($existingTarget) {
            try {
                $r1 = (Resolve-Path -LiteralPath $existingTarget -ErrorAction Stop).Path.TrimEnd('\', '/')
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
        & ln -s "$SourceDir" "$TargetDir"
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $TargetDir)) {
            throw "failed to create symlink: $TargetDir -> $SourceDir"
        }
    }
    return 'linked'
}

$skillNames = @('agent-kit-start', 'agent-delegate', 'agent-session-cleanup')
$linkDirs = @(
    (Join-Path (Join-Path $HomeDir '.claude') 'skills'),
    (Join-Path (Join-Path $HomeDir '.agents') 'skills')
)
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

foreach ($s in $skillNames) {
    $agySkillDir = Join-Path $agySkillsRoot $s
    $agySkillFile = Join-Path $agySkillDir 'SKILL.md'
    if ($Uninstall) {
        if (Test-Path -LiteralPath $agySkillFile) {
            $raw = [IO.File]::ReadAllText($agySkillFile, [Text.Encoding]::UTF8)
            if ($raw -match 'agent-kit' -and $raw -match [regex]::Escape("skills/$s/SKILL.md")) {
                Remove-Item -LiteralPath $agySkillFile -Force
                if ((Get-ChildItem -LiteralPath $agySkillDir -Force | Measure-Object).Count -eq 0) {
                    Remove-Item -LiteralPath $agySkillDir -Force
                }
                $skillCount++
            }
        }
    } else {
        $srcFile = Join-Path (Join-Path (Join-Path $kitRoot 'skills') $s) 'SKILL.md'
        $srcText = [IO.File]::ReadAllText($srcFile, [Text.Encoding]::UTF8)
        $descLine = ''
        if ($srcText -match '(?m)^description:\s*(.+)$') {
            $descLine = $Matches[1].Trim() -replace '<agent-kit>', $kitRootSlash
        }
        $connector = "---`nname: $s`ndescription: $descLine`n---`n원본은 agent-kit에 있다. $kitRootSlash/skills/$s/SKILL.md 를 읽고 그대로 따른다. 이 파일에는 절차를 쓰지 않는다.`n"
        if (-not (Test-Path -LiteralPath $agySkillDir)) {
            New-Item -ItemType Directory -Path $agySkillDir -Force | Out-Null
        }
        $writeNeeded = $true
        if (Test-Path -LiteralPath $agySkillFile) {
            $cur = [IO.File]::ReadAllText($agySkillFile, [Text.Encoding]::UTF8)
            if (($cur -replace "`r`n", "`n").Trim() -eq ($connector -replace "`r`n", "`n").Trim()) {
                $writeNeeded = $false
            }
        }
        if ($writeNeeded) {
            [IO.File]::WriteAllText($agySkillFile, $connector, (New-Object System.Text.UTF8Encoding($false)))
        }
        $skillCount++
    }
}

$legacyAgyDir = Join-Path $agySkillsRoot 'antigravity-delegate'
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

$nodeScript = @'
const fs = require('fs');
const path = require('path');

const homeDir = process.env.AGENTKIT_INSTALL_HOME;
const kitRootSlash = process.env.AGENTKIT_INSTALL_ROOT;
const mode = process.env.AGENTKIT_INSTALL_MODE;
const uninstall = mode === 'uninstall';
const guardCmd = `node ${kitRootSlash}/hooks/guard.mjs`;
const isGuardCmd = (c) => typeof c === 'string' && (c.includes('/hooks/guard.mjs') || c.includes('\\hooks\\guard.mjs'));

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

function updatePreToolUseList(list, defaultGroup) {
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
        found = true;
      }
    }
  }
  if (!found) {
    list.push(defaultGroup);
  }
  return list;
}

let updatedCount = 0;

// 1. Claude: ~/.claude/settings.json
const claudePath = path.join(homeDir, '.claude', 'settings.json');
if (!uninstall || fs.existsSync(claudePath)) {
  const claudeObj = readJson(claudePath) || {};
  if (!uninstall && claudeObj.cleanupPeriodDays === undefined) {
    claudeObj.cleanupPeriodDays = 36500;
  }
  if (!claudeObj.hooks || typeof claudeObj.hooks !== 'object') {
    claudeObj.hooks = {};
  }
  const claudeDefault = {
    matcher: 'Read|Edit|Write|NotebookEdit|Grep|Glob|Bash|PowerShell',
    hooks: [{ type: 'command', command: guardCmd, timeout: 10, statusMessage: 'guard 검사' }]
  };
  claudeObj.hooks.PreToolUse = updatePreToolUseList(claudeObj.hooks.PreToolUse, claudeDefault);
  if (uninstall && claudeObj.hooks.PreToolUse.length === 0) {
    delete claudeObj.hooks.PreToolUse;
    if (Object.keys(claudeObj.hooks).length === 0) delete claudeObj.hooks;
  }
  writeJsonIfChanged(claudePath, claudeObj);
  updatedCount++;
}

// 2. Codex: ~/.codex/hooks.json
const codexPath = path.join(homeDir, '.codex', 'hooks.json');
if (!uninstall || fs.existsSync(codexPath)) {
  const codexObj = readJson(codexPath) || {};
  if (!codexObj.hooks || typeof codexObj.hooks !== 'object') {
    codexObj.hooks = {};
  }
  const codexDefault = {
    hooks: [{ type: 'command', command: guardCmd, timeout: 10 }]
  };
  codexObj.hooks.PreToolUse = updatePreToolUseList(codexObj.hooks.PreToolUse, codexDefault);
  if (uninstall && codexObj.hooks.PreToolUse.length === 0) {
    delete codexObj.hooks.PreToolUse;
    if (Object.keys(codexObj.hooks).length === 0) delete codexObj.hooks;
  }
  writeJsonIfChanged(codexPath, codexObj);
  updatedCount++;
}

// 3. Antigravity: ~/.gemini/config/hooks.json
const agyPath = path.join(homeDir, '.gemini', 'config', 'hooks.json');
if (!uninstall || fs.existsSync(agyPath)) {
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
  updatedCount++;
}

process.stdout.write(String(updatedCount));
'@

$modeArg = if ($Uninstall) { 'uninstall' } else { 'install' }
$env:AGENTKIT_INSTALL_HOME = $HomeDir
$env:AGENTKIT_INSTALL_ROOT = $kitRootSlash
$env:AGENTKIT_INSTALL_MODE = $modeArg
$hookCount = & node -e $nodeScript
Remove-Item Env:\AGENTKIT_INSTALL_HOME, Env:\AGENTKIT_INSTALL_ROOT, Env:\AGENTKIT_INSTALL_MODE -ErrorAction SilentlyContinue
if ($LASTEXITCODE -ne 0) {
    Write-Error "failed to configure hook JSON files"
    exit 1
}

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
