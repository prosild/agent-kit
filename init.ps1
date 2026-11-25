# Copies agent instruction templates into a project folder and resolves <agent-kit>, <hc-prefix>, and <default-*>
# placeholders (using local-defaults.json when present; existing instruction files with unresolved tokens, moved kit paths,
# or legacy skills/antigravity-delegate paths are refreshed in place).
# Never overwrites user content: existing files are skipped and listed.
# Full init first gives a plain folder (git init -b main) or a commitless repository root an empty baseline commit;
# if that fails, it stops with exit 1 before copying anything (see Initialize-Repo).
# If the folder is a Git repository root, also sets up local Git safeguards:
#   - GIT-EXCLUDE: adds the agent-kit block (git-exclude.txt) to <git common dir>/info/exclude.
#                  Pass -TrackSpec to keep AGENTS.md, CLAUDE.md, SPEC.md, SESSION_HANDOFF.md and agent-roles/ tracked in Git
#                  for team/multi-machine sharing while excluding only runtime handoff/worktree artifacts
#                  (verify.ps1 ignores their pending edits in its clean-tree check; see RUNBOOK section 1).
#   - POLICY: the submission policy in local Git config, read by hooks/pre-push and hooks/guard.mjs:
#       agentkit.submission         pr | direct | local
#       agentkit.protectedBranches  CSV of branches nobody pushes to directly
#       agentkit.base               base ref for verify (only when -Base is given)
#       agentkit.crossAgentMode     auto | manual (optional; manual blocks hc run/send/keys for file-only handoff)
#       agentkit.maxVerifyFailures  max FAIL runs per approval before verify.ps1 stops (default 5 when unset; 0 = unlimited)
#       agentkit.projectRoot        folder holding handoff/ (for sub-repositories and worktrees)
#       agentkit.trackSpec          true | false (whether spec/instruction files are tracked in Git)
#   - PRE-PUSH: installs hooks/pre-push once a submission policy exists (an agent-kit copy already there is refreshed).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File <agent-kit>/init.ps1 [-Target <folder>] [-NoGit] [-TrackSpec]
#        ... init.ps1 -GitSetup -Target <repo root> [-Submission pr|direct|local] [-ProtectedBranches a,b] [-Base <ref>]
#            [-CrossAgentMode auto|manual] [-MaxVerifyFailures 5] [-ProjectRoot <folder>] [-TrackSpec]
param([string]$Target = (Get-Location).Path, [Alias('ExcludeOnly')][switch]$GitSetup, [switch]$NoGit, [switch]$TrackSpec,
      [ValidateSet('pr', 'direct', 'local')][string]$Submission, [string]$ProtectedBranches, [string]$Base,
      [ValidateSet('auto', 'manual', '')][string]$CrossAgentMode, [int]$MaxVerifyFailures, [string]$ProjectRoot = '')

$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false)
try {
    [Console]::InputEncoding = $utf8
    [Console]::OutputEncoding = $utf8
    $OutputEncoding = $utf8
} catch {}
$src = Join-Path $PSScriptRoot 'templates'
if (-not (Test-Path -LiteralPath $Target -PathType Container)) { Write-Output "ERROR target not found: $Target"; exit 2 }
$full = (Resolve-Path -LiteralPath $Target).Path.TrimEnd('\', '/'); $kit = (Resolve-Path -LiteralPath $PSScriptRoot).Path.TrimEnd('\', '/')
if ($kit -match '[\s&;|<>`"$()''\[\]]') { Write-Output "ERROR agent-kit path must not contain spaces or shell metacharacters: $kit"; exit 2 }
$fullPosix = $full.Replace('\', '/'); $kitPosix = $kit.Replace('\', '/')
if ($fullPosix -ieq $kitPosix -or $fullPosix.StartsWith("$kitPosix/", [StringComparison]::OrdinalIgnoreCase)) { Write-Output "ERROR target is inside agent-kit: $full"; exit 2 }
if (-not $GitSetup -and $full -match '[\\/]\.worktrees([\\/]|$)') { Write-Output "ERROR target is inside .worktrees ($full); initialize the project root, or pass -GitSetup"; exit 2 }
$hasSub = $PSBoundParameters.ContainsKey('Submission'); $hasProt = $PSBoundParameters.ContainsKey('ProtectedBranches')
$hasBase = $PSBoundParameters.ContainsKey('Base'); $hasCross = $PSBoundParameters.ContainsKey('CrossAgentMode')
$hasMaxFail = $PSBoundParameters.ContainsKey('MaxVerifyFailures'); $hasProjRoot = $PSBoundParameters.ContainsKey('ProjectRoot')
$hasTrackSpec = $PSBoundParameters.ContainsKey('TrackSpec')
if ($hasMaxFail -and $MaxVerifyFailures -lt 0) { Write-Output "ERROR -MaxVerifyFailures must be >= 0: $MaxVerifyFailures"; exit 2 }
if ($hasProjRoot -and $ProjectRoot -and -not (Test-Path -LiteralPath $ProjectRoot -PathType Container)) { Write-Output "ERROR -ProjectRoot not found: $ProjectRoot"; exit 2 }

# Returns @{ ok = $true; top = <root>; common = <git common dir>; hooks = <hooks dir> } or @{ ok = $false; why = <reason> }.
# Uses `git rev-parse --is-inside-work-tree` + `--show-prefix` so symlinked roots (e.g. macOS /tmp -> /private/tmp) match reliably.
function Get-Repo([string]$dir) {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return @{ ok = $false; why = 'skipped (git not found)' } }
    $ErrorActionPreference = 'Continue'
    $inside = ((& git -C $dir rev-parse --is-inside-work-tree 2>$null) -join '').Trim()
    $prefix = ((& git -C $dir rev-parse --show-prefix 2>$null) -join '').Trim()
    $top = ((& git -C $dir rev-parse --show-toplevel 2>$null) -join '').Trim()
    $common = ((& git -C $dir rev-parse --path-format=absolute --git-common-dir 2>$null) -join '').Trim()
    $hooks = ((& git -C $dir rev-parse --path-format=absolute --git-path hooks 2>$null) -join '').Trim()
    $hooksPath = ((& git -C $dir config --get core.hooksPath 2>$null) -join '').Trim()
    $ErrorActionPreference = 'Stop'
    if (-not $top -or -not $common -or $inside -ne 'true') { return @{ ok = $false; why = 'skipped (not a git repository)' } }
    $topFull = [IO.Path]::GetFullPath($top).TrimEnd('\', '/')
    if ($prefix -ne '') { return @{ ok = $false; why = "skipped (not the repository root; root is $topFull)" } }
    return @{ ok = $true; top = $topFull; common = $common; hooks = $hooks; hooksPath = $hooksPath }
}

function Format-GitOut($out) { $t = @($out | ForEach-Object { "$_".Trim() } | Where-Object { $_ }) -join ' / '; if ($t) { $t } else { 'no output' } }
function Initialize-Repo([string]$dir) {
    $r = Get-Repo $dir
    if ($NoGit -or $GitSetup) { return $r }
    if (-not $r.ok -and $r.why -ne 'skipped (not a git repository)') { return $r }
    $ErrorActionPreference = 'Continue'
    $created = $false
    if (-not $r.ok) {
        if (Test-Path -LiteralPath (Join-Path $dir '.git')) {
            $out = @(& git -C $dir rev-parse --show-toplevel 2>&1)
            return @{ ok = $false; why = 'skipped (git cannot read this repository)'; gitError = "git cannot read the repository here ($(Format-GitOut $out))" }
        }
        $out = @(& git -C $dir init -q -b main 2>&1); $code = $LASTEXITCODE
        if ($code -ne 0) {
            $out = @(& git -C $dir init -q 2>&1); $code = $LASTEXITCODE
            if ($code -eq 0) { $out = @(& git -C $dir symbolic-ref HEAD refs/heads/main 2>&1); $code = $LASTEXITCODE }
        }
        if ($code -eq 0) { $r = Get-Repo $dir }
        if ($code -ne 0 -or -not $r.ok) { return @{ ok = $false; why = 'skipped (git init failed)'; gitError = "git init FAILED ($(Format-GitOut $out))" } }
        $created = $true
    }
    $ref = ((& git -C $dir symbolic-ref -q HEAD 2>$null) -join '').Trim(); $refCode = $LASTEXITCODE
    if ($refCode -ne 0 -or -not $ref) {
        & git -C $dir rev-parse --verify --quiet HEAD 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { return $r }
        $r.gitError = 'HEAD is neither a branch nor a commit; fix the repository first'; return $r
    }
    $out = @(& git -C $dir rev-parse --verify --quiet "$ref^{commit}" 2>&1); $code = $LASTEXITCODE
    if ($code -eq 0) { return $r }
    if ($code -ne 1 -or $out.Count) { $r.gitError = "cannot tell whether $ref has commits ($(Format-GitOut $out))"; return $r }
    $branch = $ref -replace '^refs/heads/', ''
    $staged = @(& git -C $dir ls-files --cached 2>$null); $code = $LASTEXITCODE
    if ($code -ne 0) { $r.gitError = "cannot read the index of $branch (git ls-files exit $code)"; return $r }
    if ($staged.Count) { $r.gitError = "no commits yet and $($staged.Count) staged file(s) on $branch; a baseline commit would include them. Commit or unstage them yourself, then run init again"; return $r }
    $idArgs = @()
    if (-not ((& git -C $dir config --get user.name 2>$null) -join '')) { $idArgs += @('-c', 'user.name=agent-kit') }
    if (-not ((& git -C $dir config --get user.email 2>$null) -join '')) { $idArgs += @('-c', 'user.email=agent-kit@local') }
    $out = @(& git -C $dir @idArgs commit -q --allow-empty -m 'chore: initial baseline' 2>&1); $code = $LASTEXITCODE
    if ($code -eq 0) { & git -C $dir rev-parse --verify --quiet "$ref^{commit}" 2>$null | Out-Null; if ($LASTEXITCODE -ne 0) { $code = -1 } }
    if ($code -ne 0) { $r.gitError = "$(if ($created) { "initialized ($branch) but " })baseline commit FAILED ($(Format-GitOut $out))"; return $r }
    $r.gitNote = if ($created) { "initialized ($branch, baseline commit)" } else { "baseline commit created ($branch; the repository had no commits)" }
    if ($branch -notin @('main', 'master')) { $r.gitNote += ". verify.ps1 looks for main/master: give -Base $branch with -GitSetup" }
    return $r
}

function Invoke-Git($repo, [string[]]$gitArgs) {
    $ErrorActionPreference = 'Continue'
    $out = (& git -C $repo.top @gitArgs 2>$null)
    return @{ out = ((@($out) -join "`n").Trim()); code = $LASTEXITCODE }
}
function Get-Cfg($repo, [string]$key) { return (Invoke-Git $repo @('config', '--local', '--get', $key)).out }
function Set-Cfg($repo, [string]$key, [string]$val) {
    $r = if ($val -ne '') { Invoke-Git $repo @('config', '--local', '--replace-all', $key, $val) } else { Invoke-Git $repo @('config', '--local', '--unset-all', $key) }
    return ($r.code -eq 0 -or ($val -eq '' -and $r.code -eq 5)) -and ((Get-Cfg $repo $key) -ceq $val)
}
function ConvertTo-BranchList([string]$csv) {
    return (@($csv -split ',' | ForEach-Object { $_.Trim() -replace '^refs/heads/', '' } | Where-Object { $_ } | Select-Object -Unique) -join ',')
}
function Get-DefaultProtected($repo) {
    $h = Invoke-Git $repo @('symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD')
    if ($h.code -eq 0 -and $h.out -match '^origin/(.+)$') { return $Matches[1] }
    $found = @(@('main', 'master') | Where-Object {
        (Invoke-Git $repo @('show-ref', '--verify', '--quiet', "refs/heads/$_")).code -eq 0 -or
        (Invoke-Git $repo @('show-ref', '--verify', '--quiet', "refs/remotes/origin/$_")).code -eq 0 })
    if ($found.Count) { return ($found -join ',') }
    return 'main,master'
}

function Set-Policy($repo) {
    if (-not $repo.ok) {
        $why = $repo.why
        if ($why -match 'not a git repository') { $why += '; nothing stored. Without Git there is no push to guard: keep a copy of what you change (the recovery path) and record manual evidence' }
        return @{ text = $why; submission = ''; trackSpec = $false }
    }
    $keys = [ordered]@{
        submission = 'agentkit.submission'; protectedBranches = 'agentkit.protectedBranches'; base = 'agentkit.base'
        crossAgentMode = 'agentkit.crossAgentMode'; maxVerifyFailures = 'agentkit.maxVerifyFailures'
        projectRoot = 'agentkit.projectRoot'; trackSpec = 'agentkit.trackSpec'
    }
    $extraKeys = @('crossAgentMode', 'maxVerifyFailures', 'projectRoot', 'trackSpec')
    $old = @{}; foreach ($k in $keys.Keys) { $old[$k] = Get-Cfg $repo $keys[$k] }
    $new = $old.Clone(); $note = ''
    if ($hasSub) {
        $new.submission = $Submission.ToLowerInvariant()
        $protList = if ($hasProt) { ConvertTo-BranchList $ProtectedBranches } else { '' }
        $new.protectedBranches = if ($protList) { $protList } elseif ($new.submission -eq 'pr') { Get-DefaultProtected $repo } else { '' }
    } elseif ($hasProt) {
        if ($old.submission) {
            $protList = ConvertTo-BranchList $ProtectedBranches
            $new.protectedBranches = if ($protList) { $protList } elseif ($old.submission -eq 'pr') { Get-DefaultProtected $repo } else { '' }
        }
        else { $note = ' (-ProtectedBranches ignored: give -Submission too)' }
    }
    if ($hasBase) { $new.base = $Base.Trim() }
    if ($hasCross) { $new.crossAgentMode = $CrossAgentMode.ToLowerInvariant() }
    if ($hasMaxFail) { $new.maxVerifyFailures = [string]$MaxVerifyFailures }
    if ($hasProjRoot) {
        $new.projectRoot = if ($ProjectRoot) { (Resolve-Path -LiteralPath $ProjectRoot).Path.Replace('\', '/').TrimEnd('/') } else { '' }
    } elseif (-not $GitSetup -and -not $old.projectRoot) {
        # Store projectRoot silently when full init initializes the root repo without failing if config.lock test runs -GitSetup
        $null = Set-Cfg $repo 'agentkit.projectRoot' $fullPosix
        $old.projectRoot = Get-Cfg $repo 'agentkit.projectRoot'
        $new.projectRoot = $old.projectRoot
    }
    if ($hasTrackSpec) { $new.trackSpec = if ($TrackSpec) { 'true' } else { '' } }
    $parts = @(); $failed = @()
    $show = { param($x) if ($x -ne '') { $x } else { '-' } }
    foreach ($k in $keys.Keys) {
        if ($k -eq 'projectRoot' -and -not $hasProjRoot) { continue }
        $touched = ($k -eq 'crossAgentMode' -and $hasCross) -or ($k -eq 'maxVerifyFailures' -and $hasMaxFail) -or ($k -eq 'projectRoot' -and $hasProjRoot) -or ($k -eq 'trackSpec' -and $hasTrackSpec)
        if ($k -in $extraKeys -and $old[$k] -eq '' -and $new[$k] -eq '' -and -not $touched) { continue }
        if ($new[$k] -cne $old[$k]) {
            if (Set-Cfg $repo $keys[$k] $new[$k]) { $parts += "$k=$(& $show $new[$k]) (was $(& $show $old[$k]))"; continue }
            $want = $new[$k]; $new[$k] = Get-Cfg $repo $keys[$k]
            $failed += $keys[$k]; $parts += "$k=$(& $show $new[$k]) (NOT changed to $(& $show $want))"
        } else { $parts += "$k=$(& $show $new[$k])" }
    }
    if ((Get-Cfg $repo 'agentkit.denyHcProviders') -and (Set-Cfg $repo 'agentkit.denyHcProviders' '')) { $parts += 'denyHcProviders removed (no longer supported)' }
    $text = $parts -join ', '
    $isTracked = ($new.trackSpec -eq 'true')
    if ($failed) { return @{ text = "FAILED to write local Git config ($($failed -join ', ')); the policy was not applied as asked. Now: $text. Fix the cause (e.g. a leftover .git/config.lock) and run init again"; submission = $new.submission; failed = $true; trackSpec = $isTracked } }
    if (-not $new.submission) { $text = "none ($text). Designer: agree a submission mode with the user, then run init.ps1 -GitSetup -Submission pr|direct|local -Target $($repo.top). Until then older agent-kit hooks and the guard block main/master" }
    return @{ text = $text + $note; submission = $new.submission; trackSpec = $isTracked }
}

function Add-GitExclude($repo, [bool]$trackSpecMode) {
    if (-not $repo.ok) { return $repo.why }
    $info = Join-Path $repo.common 'info'
    if (-not (Test-Path -LiteralPath $info)) { New-Item -ItemType Directory -Path $info | Out-Null }
    $ex = Join-Path $info 'exclude'
    $rawBlock = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'git-exclude.txt')).Replace("`r`n", "`n")
    $block = if ($trackSpecMode) {
        $lines = $rawBlock -split "`n" | Where-Object { $_ -notin @('/AGENTS.md', '/CLAUDE.md', '/SPEC.md', '/SESSION_HANDOFF.md', '/agent-roles/') }
        ($lines -join "`n")
    } else { $rawBlock }
    $cur = if (Test-Path -LiteralPath $ex) { [IO.File]::ReadAllText($ex) } else { '' }
    if ($cur -match '(?s)# >>> agent-kit.*?# <<< agent-kit\r?\n?') {
        $normCur = $cur.Replace("`r`n", "`n")
        if ($normCur.Contains($block.TrimEnd("`n"))) { return "already present ($ex)" }
        $updated = [regex]::Replace($normCur, '(?s)# >>> agent-kit.*?# <<< agent-kit\n?', $block)
        [IO.File]::WriteAllText($ex, $updated, $utf8)
        return "updated ($ex)"
    }
    $sep = if ($cur -and -not $cur.EndsWith("`n")) { "`n" } else { '' }
    [IO.File]::AppendAllText($ex, $sep + $block, $utf8)
    return "added ($ex)"
}

function Install-PrePush($repo, [string]$submission) {
    if (-not $repo.ok) { return $repo.why }
    if ($repo.hooksPath) { return "skipped (core.hooksPath is set to '$($repo.hooksPath)'; add the agent-kit pre-push there by hand if wanted)" }
    $dest = Join-Path $repo.hooks 'pre-push'
    $body = [IO.File]::ReadAllText((Join-Path (Join-Path $PSScriptRoot 'hooks') 'pre-push')).Replace("`r`n", "`n")
    if (Test-Path -LiteralPath $dest) {
        $cur = [IO.File]::ReadAllText($dest)
        if ($cur -match 'agent-kit pre-push') {
            if ($cur -ceq $body) {
                if ($env:OS -ne 'Windows_NT') { try { & chmod +x $dest 2>$null } catch {} }
                return "already present ($dest)"
            }
            [IO.File]::WriteAllText($dest, $body, $utf8)
            if ($env:OS -ne 'Windows_NT') { try { & chmod +x $dest 2>$null } catch {} }
            return "updated ($dest)"
        }
        return "skipped (an existing pre-push hook is not agent-kit's: $dest)"
    }
    if (-not $submission) { return 'skipped (no agentkit.submission; ask the designer to choose a submission mode)' }
    if (-not (Test-Path -LiteralPath $repo.hooks)) { New-Item -ItemType Directory -Path $repo.hooks | Out-Null }
    [IO.File]::WriteAllText($dest, $body, $utf8)
    if ($env:OS -ne 'Windows_NT') { try { & chmod +x $dest 2>$null } catch {} }
    return "installed ($dest)"
}

function Write-Tools { try { Write-Output (& (Join-Path $PSScriptRoot 'check-tools.ps1')) } catch { Write-Output 'TOOLS: check failed' } }
$script:policyFailed = $false
function Write-Git($repo) {
    if ($repo.gitNote) { Write-Output "GIT: $($repo.gitNote)" }
    $policy = Set-Policy $repo
    if ($policy.failed) { $script:policyFailed = $true }
    Write-Output ("GIT-EXCLUDE: " + (Add-GitExclude $repo ([bool]$policy.trackSpec)))
    Write-Output ("POLICY: " + $policy.text)
    Write-Output ("PRE-PUSH: " + (Install-PrePush $repo $policy.submission))
}
if ($GitSetup) {
    Write-Git (Get-Repo $full)
    Write-Tools
    exit $(if ($script:policyFailed) { 1 } else { 0 })
}

$repo = Initialize-Repo $full
if ($repo.gitError) {
    Write-Output "GIT: $($repo.gitError)"
    Write-Output 'NEXT: stopped before copying any instruction file. Fix the cause and run init.ps1 again (or add -NoGit for work without Git).'
    exit 1
}

# hc name prefix <p> for this project (RUNBOOK section 3): lower-case letters/digits of the folder name, first 6;
# shorter than 3 (e.g. a Korean name) gets hash characters of the full path appended.
$hcp = ((Split-Path -Leaf $full).ToLowerInvariant() -replace '[^a-z0-9]', '')
if ($hcp.Length -lt 3) {
    $sha = [Security.Cryptography.SHA1]::Create()
    $hex = -join ($sha.ComputeHash($utf8.GetBytes($full.ToLowerInvariant())) | ForEach-Object { $_.ToString('x2') })
    $hcp = $hcp + 'p' + $hex
}
$hcp = $hcp.Substring(0, [Math]::Min(6, $hcp.Length))
$kitPosix = $kit.Replace('\', '/')
$defDesigner = [regex]::Unescape('<\uC124\uACC4\uC790 \uB3C4\uAD6C\u00B7\uBAA8\uB378 (\uC608: Codex / Claude / Antigravity)>')
$defLaunch   = [regex]::Unescape('\uC0AC\uC6A9\uC790\uAC00 \uD130\uBBF8\uB110\uC5D0\uC11C \uC2DC\uC791(Codex\uB294 ') + '`codex --no-daemon`)'
$defWorker   = [regex]::Unescape('<\uC791\uC5C5\uC790 \uB3C4\uAD6C\u00B7\uBAA8\uB378 (\uAC00\uBCCD\uC6C0: \uD45C\uC900 \uBAA8\uB378 / \uBB34\uAC70\uC6C0: \uACE0\uC131\uB2A5 \uBAA8\uB378)>')
$defReviewer = [regex]::Unescape('<\uAC80\uD1A0\u00B7\uC870\uC0AC \uB3C4\uAD6C\u00B7\uBAA8\uB378 (\uC77C\uBC18\u00B7\uC870\uC0AC: \uD45C\uC900 \uBAA8\uB378 / \uC911\uC694: \uACE0\uC131\uB2A5 \uBAA8\uB378)>')
$defNote = ''
$localDefPath = if ($env:AGENTKIT_DEFAULTS_FILE) {
    if ($env:AGENTKIT_DEFAULTS_FILE -eq 'off') { '' } else { $env:AGENTKIT_DEFAULTS_FILE }
} else { Join-Path $PSScriptRoot 'local-defaults.json' }
function Clean-Cell($v) {
    if ($null -eq $v -or $v -isnot [string]) { return '' }
    return (($v -replace '[\r\n]+', ' ' -replace '\|', '/').Trim())
}
if ($localDefPath -and (Test-Path -LiteralPath $localDefPath -PathType Leaf)) {
    try {
        $ld = [IO.File]::ReadAllText($localDefPath) | ConvertFrom-Json
        $c1 = Clean-Cell $ld.designer;       if ($c1) { $defDesigner = $c1 }
        $c2 = Clean-Cell $ld.designerLaunch; if ($c2) { $defLaunch   = $c2 }
        $c3 = Clean-Cell $ld.worker;         if ($c3) { $defWorker   = $c3 }
        $c4 = Clean-Cell $ld.reviewer;       if ($c4) { $defReviewer = $c4 }
    } catch {
        $defNote = "WARN invalid JSON in $localDefPath ($($_.Exception.Message)); placeholder defaults used"
    }
}
$hcPrefixLabel = [regex]::Unescape('hc \uC774\uB984 \uC57D\uCE6D')
function Resolve-TemplateText([string]$txt, [bool]$isAgents, [bool]$isExisting) {
    $map = @{
        'agent-kit' = $kitPosix
        'hc-prefix' = $hcp
        'default-designer' = $defDesigner.Replace('<agent-kit>', $kitPosix)
        'default-designer-launch' = $defLaunch.Replace('<agent-kit>', $kitPosix)
        'default-worker' = $defWorker.Replace('<agent-kit>', $kitPosix)
        'default-reviewer' = $defReviewer.Replace('<agent-kit>', $kitPosix)
    }
    $pat = if ($isAgents) { '<(agent-kit|hc-prefix|default-designer|default-designer-launch|default-worker|default-reviewer)>' } else { '<(agent-kit)>' }
    $res = [regex]::Replace($txt, $pat, { param($m) $map[$m.Groups[1].Value] })
    $res = $res.Replace('/skills/antigravity-delegate/', '/skills/agent-delegate/')
    # Refresh moved agent-kit absolute paths inside existing project instruction files (README.md section "재개")
    if ($isExisting) {
        $res = [regex]::Replace($res, '(?:[A-Za-z]:/|/|~/)[^\s`"''<>()|]+?/agent-kit(?=/(?:init\.ps1|verify\.ps1|check-tools\.ps1|cleanup\.ps1|update-tools\.ps1|RUNBOOK\.md|EXPERIENCE\.md|PRINCIPLES\.md|skills/|hooks/|templates/))', $kitPosix)
        if ($isAgents -and $res -notmatch [regex]::Escape($hcPrefixLabel)) {
            $lineToAdd = "- $hcPrefixLabel ``<p>``: ``$hcp``"
            if ($res -match '(?m)^# .+\r?\n') {
                $res = [regex]::Replace($res, '(?m)^(# .+\r?\n)', "`$1$lineToAdd`n", 1)
            }
        }
    }
    return $res
}

$created = @(); $skipped = @(); $updated = @()
foreach ($f in Get-ChildItem -LiteralPath $src -File) {
    if ($f.Name -in @('CLAUDE.md', 'GEMINI.md')) { continue }
    $dest = Join-Path $full $f.Name
    $isAg = ($f.Name -ieq 'AGENTS.md')
    if (Test-Path -LiteralPath $dest) {
        $skipped += $f.Name
        $cur = [IO.File]::ReadAllText($dest)
        $resolved = Resolve-TemplateText $cur $isAg $true
        if ($resolved -cne $cur) { [IO.File]::WriteAllText($dest, $resolved, $utf8); $updated += $f.Name }
    } else {
        $raw = [IO.File]::ReadAllText($f.FullName)
        [IO.File]::WriteAllText($dest, (Resolve-TemplateText $raw $isAg $false), $utf8)
        $created += $f.Name
    }
}
foreach ($sub in Get-ChildItem -LiteralPath $src -Directory) {
    $destDir = Join-Path $full $sub.Name
    if (-not (Test-Path -LiteralPath $destDir)) { New-Item -ItemType Directory -Path $destDir | Out-Null; $created += "$($sub.Name)/" }
    foreach ($f in Get-ChildItem -LiteralPath $sub.FullName -File) {
        $relName = "$($sub.Name)/$($f.Name)"
        $dest = Join-Path $destDir $f.Name
        if (Test-Path -LiteralPath $dest) {
            $skipped += $relName
            $cur = [IO.File]::ReadAllText($dest)
            $resolved = Resolve-TemplateText $cur $false $true
            if ($resolved -cne $cur) { [IO.File]::WriteAllText($dest, $resolved, $utf8); $updated += $relName }
        } else {
            $raw = [IO.File]::ReadAllText($f.FullName)
            [IO.File]::WriteAllText($dest, (Resolve-TemplateText $raw $false $false), $utf8)
            $created += $relName
        }
    }
}
# Claude Code reads AGENTS.md by itself only when no CLAUDE.md-family file exists in the project folder or above it
# (measured 2026-11-26). When one exists, a project CLAUDE.md that imports @AGENTS.md brings the role rules back.
$agentsLoadNote = ''
$claudeFamily = @()
$probe = $full
while ($probe) {
    foreach ($n in @('CLAUDE.md', 'CLAUDE.local.md', (Join-Path '.claude' 'CLAUDE.md'))) {
        $cand = Join-Path $probe $n
        if (Test-Path -LiteralPath $cand -PathType Leaf) { $claudeFamily += $cand }
    }
    $parentDir = Split-Path -Parent $probe
    if (-not $parentDir -or $parentDir -eq $probe) { break }
    $probe = $parentDir
}
if ($claudeFamily.Count) {
    $projClaude = Join-Path $full 'CLAUDE.md'
    if (-not (Test-Path -LiteralPath $projClaude)) {
        [IO.File]::WriteAllText($projClaude, "@AGENTS.md`n", $utf8)
        $created += 'CLAUDE.md'
        $agentsLoadNote = "created CLAUDE.md with an @AGENTS.md import (Claude Code skips AGENTS.md because of $($claudeFamily[0]))"
    } elseif ([IO.File]::ReadAllText($projClaude) -notmatch '(?m)^\s*@AGENTS\.md\s*$') {
        $agentsLoadNote = "WARN Claude Code will not read AGENTS.md here ($($claudeFamily[0]) exists); add a line '@AGENTS.md' to $projClaude"
    }
}
if ($defNote) { Write-Output "DEFAULTS: $defNote" }
if ($agentsLoadNote) { Write-Output "AGENTS-LOAD: $agentsLoadNote" }
Write-Output ("CREATED: " + ($(if ($created) { $created -join ', ' } else { '-' })))
Write-Output ("SKIPPED (already exist): " + ($(if ($skipped) { $skipped -join ', ' } else { '-' })))
if ($updated) { Write-Output ("UPDATED (placeholders/paths refreshed): " + ($updated -join ', ')) }
Write-Git $repo
Write-Tools
if ($skipped) { Write-Output "NEXT: existing files were preserved. This is not a fresh start; do not overwrite or auto-merge them. Continue with the project instructions, or merge templates per RUNBOOK.md section 11 (handoff/T00.md)." }
else { Write-Output "NEXT: continue with $kitPosix/skills/agent-kit-start/SKILL.md (read DESIGNER.md and agree the project before filling AGENTS.md and SPEC.md)." }
exit $(if ($script:policyFailed) { 1 } else { 0 })
