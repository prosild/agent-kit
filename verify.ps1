# Verify a Git task against the designer's approved handoff and pinned base.
# -Prepare: freeze criteria before implementation; no check command runs (works for manual `verify: -` Git tasks too).
# Default: worker check (runs the verify command and writes immutable evidence under handoff/<ID>/verify/runs/<run>/).
# -Accept [-ReviewedCommit SHA] [-ReviewReport path] [-Rerun] [-Manual]:
#   designer acceptance against the latest valid worker PASS on the same commit & approval without re-running slow tests
#   by default (-Rerun forces re-execution; -Manual records acceptance for a `verify: -` Git task after manual inspection).
# -CheckAccepted: compare the current tip/criteria/clean tree immediately before submission.
param(
    [Parameter(Mandatory = $true)][string]$Id,
    [string]$Project = (Get-Location).Path, [string]$Repo = '', [string]$Base = '',
    [switch]$Prepare, [switch]$Accept, [switch]$CheckAccepted, [switch]$Rerun, [switch]$Manual,
    [string]$ReviewedCommit = '', [string]$ReviewReport = ''
)
$ErrorActionPreference = 'Stop'
function Usage([string]$message) { Write-Output "ERROR $message"; exit 2 }
if ($Id -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]*$') { Usage "bad id (use letters, digits, '-', '_'; '.' is rejected by hc --name): $Id" }
if ((@($Prepare, $Accept, $CheckAccepted) | Where-Object { $_ }).Count -gt 1) { Usage 'choose only one mode' }
if ($ReviewedCommit -and -not $Accept) { Usage '-ReviewedCommit is for -Accept only' }
if ($ReviewReport -and -not $Accept) { Usage '-ReviewReport is for -Accept only' }
if ($Rerun -and -not $Accept) { Usage '-Rerun is for -Accept only' }
if ($Manual -and -not $Accept) { Usage '-Manual is for -Accept only' }
if (-not (Test-Path -LiteralPath $Project -PathType Container)) { Usage "project not found: $Project" }
$Project = (Resolve-Path -LiteralPath $Project).Path
if ($Project -match '[\\/]\.worktrees([\\/]|$)') { Usage 'pass -Project <project folder> -Repo <worktree folder>' }
if (-not $Repo) { $Repo = $Project }
if (-not [IO.Path]::IsPathRooted($Repo)) { $Repo = Join-Path (Get-Location).Path $Repo }
$Repo = [IO.Path]::GetFullPath($Repo).TrimEnd('\', '/')
$queryRepo = $Repo
if ($Prepare) {
    while (-not (Test-Path -LiteralPath $queryRepo -PathType Container)) {
        $parent = Split-Path -Parent $queryRepo
        if (-not $parent -or $parent -eq $queryRepo) { Usage "repository ancestor not found: $Repo" }
        $queryRepo = $parent
    }
} elseif (-not (Test-Path -LiteralPath $Repo -PathType Container)) { Usage "repo not found: $Repo" }
$handoff = Join-Path (Join-Path $Project 'handoff') "$Id.md"
if (-not (Test-Path -LiteralPath $handoff -PathType Leaf)) { Usage "handoff file not found: $handoff" }
$task = Join-Path (Join-Path $Project 'handoff') $Id
$latest = Join-Path $task 'verify'
$approvedPath = Join-Path $task 'approved.json'
$acceptedPath = Join-Path $task 'accepted.json'
$utf8 = [Text.UTF8Encoding]::new($false)
try {
    [Console]::InputEncoding = $utf8
    [Console]::OutputEncoding = $utf8
    $OutputEncoding = $utf8
} catch {}
function Write-Json([string]$path, $value) {
    $dir = Split-Path -Parent $path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
    [IO.File]::WriteAllText($path, ($value | ConvertTo-Json -Depth 8), $utf8)
}
function Read-Json([string]$path) {
    if (Test-Path -LiteralPath $path) {
        try { return ([IO.File]::ReadAllText($path) | ConvertFrom-Json) } catch {}
    }
    return $null
}
function Clear-Accepted {
    if (Test-Path -LiteralPath $acceptedPath) { Remove-Item -LiteralPath $acceptedPath -Force }
}
function Fail([string]$message) {
    if (-not $CheckAccepted -and -not $Accept) { Clear-Accepted }
    Write-Output "RESULT: FAIL $message"; exit 1
}
function Compute-NormalizedHash([string]$path) {
    $normText = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8).Replace("`r`n", "`n")
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return -join ($sha.ComputeHash($utf8.GetBytes($normText)) | ForEach-Object { $_.ToString('X2') })
    } finally { $sha.Dispose() }
}
$gitErrors = [Collections.Generic.List[string]]::new()
function Read-Git([string[]]$GitArgs, [switch]$Probe) {
    $saved = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
        $data = @(& git -c core.quotepath=false -C $queryRepo @GitArgs 2>$null)
        if ($LASTEXITCODE -eq 0) { return $data }
    } catch {} finally { $ErrorActionPreference = $saved }
    if (-not $Probe) { $gitErrors.Add("git failed: $($GitArgs -join ' ')") }
}
function Head { return ((Read-Git @('rev-parse', '--verify', 'HEAD')) -join '').Trim() }
function State {
    $tracked = @(Read-Git @('status', '--short', '--untracked-files=no'))
    $untracked = @(Read-Git @('ls-files', '--others', '--exclude-standard'))
    $isSparse = (((Read-Git @('config', '--bool', '--get', 'core.sparseCheckout') -Probe) -join '').Trim() -eq 'true')
    $hiddenPat = if ($isSparse) { '^[a-z] ' } else { '^(S|[a-z]) ' }
    $hidden = @(Read-Git @('ls-files', '-v') | Where-Object { $_ -cmatch $hiddenPat })
    return [pscustomobject]@{ tracked=$tracked; untracked=$untracked; hidden=$hidden; dirty=($tracked.Count -or $untracked.Count -or $hidden.Count) }
}
function Handoff-Hash { return Compute-NormalizedHash $handoff }
$specPath = Join-Path $Project 'SPEC.md'
function Spec-Hash { if (Test-Path -LiteralPath $specPath -PathType Leaf) { return Compute-NormalizedHash $specPath }; return '' }

function Collect-Evidence([long]$headEpoch) {
    $evidenceDir = Join-Path $task 'evidence'
    $evidenceList = @(); $staleEvidence = @()
    if (Test-Path -LiteralPath $evidenceDir -PathType Container) {
        $evPrefix = [IO.Path]::GetFullPath($evidenceDir).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
        foreach ($ef in @(Get-ChildItem -LiteralPath $evidenceDir -Recurse -File -ErrorAction SilentlyContinue | Sort-Object FullName)) {
            $rel = $ef.FullName.Substring($evPrefix.Length).Replace('\', '/')
            $ehash = (Get-FileHash -LiteralPath $ef.FullName -Algorithm SHA256).Hash
            $mtimeUtc = $ef.LastWriteTimeUtc
            $mtimeEpoch = [DateTimeOffset]::new($mtimeUtc).ToUnixTimeSeconds()
            $stale = ($headEpoch -gt 0 -and ($mtimeEpoch + 60) -lt $headEpoch)
            if ($stale) { $staleEvidence += $rel }
            $evidenceList += [ordered]@{ path=$rel; sha256=$ehash; mtimeUtc=$mtimeUtc.ToString('o'); stale=$stale }
        }
    }
    return @{ list = $evidenceList; stale = $staleEvidence }
}

function Validate-ReviewReport([string]$reportArg, [string]$expectedHead) {
    if (-not $reportArg) { return @{ path = ''; verdict = '' } }
    $rp = if ([IO.Path]::IsPathRooted($reportArg)) { $reportArg } else { Join-Path $Project $reportArg }
    $rp = [IO.Path]::GetFullPath($rp)
    if (-not (Test-Path -LiteralPath $rp -PathType Leaf)) { Fail "review report not found: $reportArg" }
    $nonEmpty = @([IO.File]::ReadAllLines($rp, [Text.Encoding]::UTF8) | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $verdictLine = @($nonEmpty | Select-Object -First 5 | Where-Object { $_ -match '^판정\s*:' }) | Select-Object -First 1
    if (-not $verdictLine -and $nonEmpty.Count) { $verdictLine = $nonEmpty[0] }
    if (-not $verdictLine -or $verdictLine -match '(?i)(중단|수정\s*후\s*진행)' -or $verdictLine -notmatch '^판정:\s*진행\s*가능(\s*\|\s*높음\s+0\b|$)') {
        Fail "review report verdict is not pass ($verdictLine)"
    }
    $commitLine = @($nonEmpty | Select-Object -First 10 | Where-Object { $_ -match '^검토\s*commit\s*:\s*([0-9a-fA-F]{40})\b' }) | Select-Object -First 1
    if ($commitLine -and $commitLine -match '^검토\s*commit\s*:\s*([0-9a-fA-F]{40})\b') {
        if ($Matches[1].ToLowerInvariant() -ne $expectedHead.ToLowerInvariant()) {
            Fail "review report commit ($($Matches[1])) differs from current HEAD ($expectedHead)"
        }
    }
    return @{ path = $rp; verdict = $verdictLine }
}

# Parse YAML-like header strictly so typos like `verify : cmd` are caught immediately instead of silently degrading to NONE.
$header = @{}; $lines = [IO.File]::ReadAllLines($handoff, [Text.Encoding]::UTF8)
if ($lines.Count -and $lines[0].Trim() -eq '---') {
    for ($i = 1; $i -lt $lines.Count; $i++) {
        $trimmed = $lines[$i].Trim()
        if ($trimmed -eq '---') { break }
        if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
        if ($lines[$i] -match '^(id|verify|base|review|deps|worktree):\s*(.*)$') {
            $k = $Matches[1]
            if ($header.ContainsKey($k)) { Usage "duplicate header: $k" }
            $header[$k] = $Matches[2].Trim()
        } else {
            Usage "invalid header line in handoff/$Id.md: $($lines[$i])"
        }
    }
}
$handoffHash = Handoff-Hash
$cmd = [string]$header['verify']
if ($cmd -match '^-?\s*(#.*)?$') { $cmd = '' }

# Manual / no-command path: worker runs still return NONE (exit 3), while -Prepare / -Accept -Manual / -CheckAccepted work cleanly on Git repos.
if (-not $cmd -and -not $Prepare -and -not ($Accept -and $Manual) -and -not $CheckAccepted) {
    $priorApproved = Read-Json $approvedPath
    if ($priorApproved -and ($priorApproved.handoffHash -ne $handoffHash -or $priorApproved.command)) {
        Clear-Accepted
        Fail 'handoff changed since approval; report to designer'
    }
    if ($Accept) {
        Clear-Accepted
        Write-Output 'COMMAND: -'; Write-Output 'EXIT: not run (no verify command; pass -Manual with -Accept after inspecting manual evidence)'
        Write-Output 'RESULT: NONE (no verify command; use manual evidence or -Accept -Manual)'; exit 3
    }
    Write-Output 'COMMAND: -'; Write-Output 'EXIT: not run (no verify command)'
    Write-Output 'RESULT: NONE (no verify command; use manual evidence)'; exit 3
}
if (-not $cmd -and $CheckAccepted) {
    $priorApproved = Read-Json $approvedPath
    if ($priorApproved -and ($priorApproved.handoffHash -ne $handoffHash -or $priorApproved.command)) {
        Fail 'handoff changed since approval; report to designer'
    }
    $acceptedCheck = Read-Json $acceptedPath
    if (-not $acceptedCheck) {
        Write-Output 'COMMAND: -'; Write-Output 'EXIT: not run (no verify command)'
        Write-Output 'RESULT: NONE (no verify command; use manual evidence)'; exit 3
    }
}

$insideOut = ((Read-Git @('rev-parse', '--is-inside-work-tree') -Probe) -join '').Trim()
$prefixOut = ((Read-Git @('rev-parse', '--show-prefix') -Probe) -join '').Trim()
$topOut = ((Read-Git @('rev-parse', '--show-toplevel') -Probe) -join '').Trim()
if (-not $topOut -or $insideOut -ne 'true') { Fail 'Git repository unavailable; use manual evidence for non-Git work' }
$topFull = [IO.Path]::GetFullPath($topOut).TrimEnd('\', '/')
if (-not $Prepare -and $prefixOut -ne '') { Fail "Repo is not a repository or worktree root: $Repo (root is $topFull)" }
if ($Prepare -and $prefixOut -ne '') {
    $wtDir = Join-Path $topFull '.worktrees'
    $parentName = Split-Path -Leaf $queryRepo
    if (-not ($parentName -ieq '.worktrees' -and $prefixOut -replace '[/\\]+$', '' -ieq '.worktrees' -and (Split-Path -Parent $Repo) -ieq $queryRepo)) {
        Fail "Repo is not a repository or worktree root: $Repo (root is $topFull)"
    }
}
$common = ((Read-Git @('rev-parse', '--path-format=absolute', '--git-common-dir')) -join '').Replace('\', '/').TrimEnd('/')

if ($Prepare) {
    $baseRef = ''; $baseCommit = ''
    $specified = if ($Base) { $Base } elseif ($header['base']) { $header['base'] } else { (Read-Git @('config', '--local', '--get', 'agentkit.base') -Probe) -join '' }
    $candidates = if ($specified) { @($specified) } else {
        @((Read-Git @('symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD') -Probe)) + @('origin/main', 'main', 'origin/master', 'master')
    }
    foreach ($b in $candidates) {
        if (-not $b) { continue }
        $sha = (Read-Git @('rev-parse', '--verify', '--quiet', '--end-of-options', "$b^{commit}") -Probe) -join ''
        if ($sha) { $baseRef = $b; $baseCommit = $sha; break }
    }
    if (-not $baseCommit) { Fail 'no valid base branch; designer must specify -Base before implementation' }
    if (-not (Head) -or $gitErrors.Count) { Fail ($gitErrors -join '; ') }
    # Record projectRoot in local git config so hooks/pre-push finds handoff/ even in sub-repo or worktree layouts.
    $null = Read-Git @('config', '--local', '--replace-all', 'agentkit.projectRoot', ($Project.Replace('\', '/').TrimEnd('/'))) -Probe
    New-Item -ItemType Directory -Force (Join-Path $task 'approvals') | Out-Null
    $approved = [ordered]@{
        version=1; approval=[guid]::NewGuid().ToString('N'); id=$Id; repo=$Repo; common=$common
        handoffHash=$handoffHash; specHash=(Spec-Hash); command=$cmd; review=$(if ($header['review']) { $header['review'] } else { 'normal' })
        baseRef=$baseRef; baseCommit=$baseCommit; prepared=(Get-Date).ToString('o')
    }
    if ($approved.review -notin @('normal', 'critical')) { Usage 'review must be normal or critical' }
    Write-Json (Join-Path (Join-Path $task 'approvals') "$($approved.approval).json") $approved
    Write-Json $approvedPath $approved
    Clear-Accepted
    Write-Output "BASE: $baseRef"; Write-Output "BASE-COMMIT: $baseCommit"
    Write-Output 'RESULT: PASS (prepared; check command not run)'; exit 0
}

$approved = Read-Json $approvedPath
if (-not $approved -or $approved.version -ne 1) { Fail 'approved snapshot missing/invalid; ask designer to run -Prepare' }
if ($approved.common -ine $common -or ($approved.repo -ine $Repo -and $prefixOut -ne '')) { Fail 'repository differs from approved handoff' }
if ($approved.repo -ine $Repo) {
    # Allow symlink alias only when git --show-toplevel matches; reject switching between main repo and worktree.
    $appTop = ''
    if (Test-Path -LiteralPath $approved.repo -PathType Container) {
        $savedEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        try { $appTop = ((& git -C $approved.repo rev-parse --show-toplevel 2>$null) -join '').Trim() } catch {} finally { $ErrorActionPreference = $savedEap }
    }
    if (-not $appTop -or [IO.Path]::GetFullPath($appTop).TrimEnd('\', '/') -ine $topFull) { Fail 'repository differs from approved handoff' }
}
if ($approved.handoffHash -ne $handoffHash -or [string]$approved.command -cne $cmd) {
    if (-not $CheckAccepted) { Clear-Accepted }
    Fail 'handoff changed since approval; report to designer'
}
if ($Base -and $Base -cne $approved.baseRef) {
    if (-not $CheckAccepted) { Clear-Accepted }
    Fail '-Base differs from approved base; report to designer'
}
$head = Head
if ($CheckAccepted) {
    $accepted = Read-Json $acceptedPath
    $state = State
    if (-not $accepted -or $accepted.approval -ne $approved.approval -or $accepted.commit -ne $head -or $accepted.handoffHash -ne $handoffHash) { Fail 'no acceptance for this commit and handoff' }
    if ($state.dirty -or $gitErrors.Count) { Fail 'working tree is not clean or Git check failed' }
    Write-Output "COMMIT: $head"; Write-Output "ACCEPTED-RUN: $($accepted.run)"
    Write-Output 'RESULT: PASS (accepted tip unchanged; compare remote PR head separately)'; exit 0
}

# Locate the most recent worker run for this approval, without letting a prior -Accept overwrite or destroy it.
function Find-LatestWorkerRun {
    $runsDir = Join-Path $latest 'runs'
    if (Test-Path -LiteralPath $runsDir -PathType Container) {
        $dirs = @(Get-ChildItem -LiteralPath $runsDir -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending)
        foreach ($d in $dirs) {
            $rj = Read-Json (Join-Path $d.FullName 'run.json')
            if ($rj -and (-not $rj.kind -or $rj.kind -eq 'verify')) { return $rj }
        }
    }
    $lat = Read-Json (Join-Path $latest 'run.json')
    if ($lat -and (-not $lat.kind -or $lat.kind -eq 'verify')) { return $lat }
    return $null
}

$reviewInfo = @{ path = ''; verdict = '' }
if ($Accept) {
    if ($approved.review -eq 'critical' -and -not $ReviewedCommit) { Fail 'critical acceptance requires -ReviewedCommit from the review report' }
    if ($ReviewedCommit -and $ReviewedCommit -cne $head) { Fail 'reviewed commit differs from current HEAD' }
    $reviewInfo = Validate-ReviewReport $ReviewReport $head
    $stateNow = State
    if ($stateNow.dirty -or $gitErrors.Count) { Fail 'uncommitted or hidden changes (before/after)' }
    $headEpochAccept = 0L; [void][long]::TryParse(((Read-Git @('log', '-1', '--format=%ct')) -join ''), [ref]$headEpochAccept)
    $evAccept = Collect-Evidence $headEpochAccept

    if (-not $cmd -and $Manual) {
        $diffCheck = @(Read-Git @('diff', "$($approved.baseCommit)...HEAD"))
        $specHashNow = Spec-Hash
        $manualRec = [ordered]@{
            kind='accept'; manual=$true; result='PASS'; commit=$head; approval=$approved.approval
            handoffHash=$handoffHash; specHash=$specHashNow; command=''; run='manual'
            reviewedCommit=$ReviewedCommit; reviewReport=$reviewInfo.path; reviewVerdict=$reviewInfo.verdict
            evidence=$evAccept.list
        }
        Write-Json $acceptedPath $manualRec
        Write-Output "COMMIT: $head"; Write-Output "DIFF-LINES: $($diffCheck.Count)"
        Write-Output 'RESULT: PASS (manual acceptance recorded)'; exit 0
    }

    $workerRun = Find-LatestWorkerRun
    $existingAccepted = Read-Json $acceptedPath
    if (-not $workerRun -or $workerRun.result -ne 'PASS' -or $workerRun.approval -ne $approved.approval -or $workerRun.commit -ne $head) {
        Fail 'acceptance requires a prior worker PASS on this commit and approval'
    }
    # Prevent blind re-acceptance without new worker run unless updating -ReviewReport or explicitly passing -Rerun.
    if ($existingAccepted -and $existingAccepted.approval -eq $approved.approval -and $existingAccepted.commit -eq $head -and $existingAccepted.workerRun -eq $workerRun.run -and -not $ReviewReport -and -not $Rerun) {
        Clear-Accepted
        Fail 'acceptance requires a prior worker PASS on this commit and approval (already accepted; pass -ReviewReport to attach a report or -Rerun)'
    }

    if (-not $Rerun) {
        $specHashNow = Spec-Hash
        $approvedSpecHash = if ($approved.PSObject.Properties['specHash']) { [string]$approved.specHash } else { '' }
        $specChanged = if ($approvedSpecHash -and $specHashNow -ne $approvedSpecHash) { 'yes (SPEC.md changed since -Prepare)' } elseif (-not $approvedSpecHash -and $specHashNow) { 'yes (SPEC.md added since -Prepare)' } else { 'no' }
        $accRecord = [ordered]@{
            kind='accept'; result='PASS'; commit=$head; approval=$approved.approval
            handoffHash=$handoffHash; specHash=$specHashNow; command=$cmd
            run=$workerRun.run; workerRun=$workerRun.run; reviewedCommit=$ReviewedCommit
            reviewReport=$reviewInfo.path; reviewVerdict=$reviewInfo.verdict; evidence=$evAccept.list
        }
        Write-Json $acceptedPath $accRecord
        Write-Output "ID: $Id"; Write-Output "REPO: $Repo"; Write-Output "COMMIT: $head"
        Write-Output "APPROVAL: $($approved.approval)"; Write-Output "SPEC-CHANGED: $specChanged"
        Write-Output "VERIFIED-RUN: $($workerRun.run)"
        Write-Output 'RESULT: PASS (accepted from verified worker run; check command not re-executed)'
        exit 0
    }
}

# Worker run (or explicit -Accept -Rerun): invalidates any prior acceptance before executing the check command.
Clear-Accepted
if (-not $Accept) {
    $maxFailCfg = (Read-Git @('config', '--local', '--get', 'agentkit.maxVerifyFailures') -Probe) -join ''
    $maxFail = 5
    if ($maxFailCfg -match '^\d+$') { $maxFail = [int]$maxFailCfg }
    $runsDir = Join-Path $latest 'runs'
    if ($maxFail -gt 0 -and (Test-Path -LiteralPath $runsDir -PathType Container)) {
        $priorFails = 0
        foreach ($rf in Get-ChildItem -LiteralPath $runsDir -Directory -ErrorAction SilentlyContinue) {
            $rj = Read-Json (Join-Path $rf.FullName 'run.json')
            if ($rj -and $rj.approval -eq $approved.approval -and (-not $rj.kind -or $rj.kind -eq 'verify') -and ([string]$rj.result).StartsWith('FAIL')) { $priorFails++ }
        }
        if ($priorFails -ge $maxFail) {
            Fail "max verify failures ($maxFail) reached for approval $($approved.approval); report to designer"
        }
    }
}

$run = (Get-Date -Format 'yyyyMMddTHHmmssfff') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8)
$out = Join-Path (Join-Path $latest 'runs') $run
New-Item -ItemType Directory -Force $out | Out-Null
function Save([string]$name, $data) { [IO.File]::WriteAllLines((Join-Path $out $name), [string[]]@($data | ForEach-Object { "$_" }), $utf8) }
Write-Json (Join-Path $out 'approved.json') $approved
$before = State
$commit = (Read-Git @('log', '-1', '--format=%H %cI')) -join ''
Save 'status.txt' (@($before.tracked) + @($before.untracked | ForEach-Object { "?? $_" }) + @($before.hidden | ForEach-Object { "hidden: $_" }))
Save 'files.txt' @(Read-Git @('ls-files'))
$diff = @(Read-Git @('diff', "$($approved.baseCommit)...HEAD"))
Save 'diff.patch' $diff
$names = @(Read-Git @('diff', '--name-status', "$($approved.baseCommit)...HEAD"))
Save 'changed.txt' $names

# Test modification / weakening signals (covers separator paths, CamelCase *Tests.cs/*.java/*.kt, Rust #[cfg(test)], Go t.Fatal, pytest.skip, etc.)
$allTestFiles = @($names | Where-Object {
    $_ -match '(?i)(^|[/\\\t._"-])(tests?|specs?|__tests__)([/\\._"-]|$)' -or
    $_ -cmatch '[A-Za-z0-9](Tests?|Specs?)\.(cs|java|kt|kts|scala|swift|go|rs|py|rb|php|[cm]?[jt]sx?)"?$'
})
$addedTests = @($allTestFiles | Where-Object { $_ -match '^A\t' })
$testChanges = @($allTestFiles | Where-Object { $_ -notmatch '^A\t' })
$skipChanges = @($diff | Where-Object { $_ -match '^\+(?!\+\+).*(\.skip\b|\.only\b|\.todo\b|\b(xit|xdescribe|fit|fdescribe)\s*\(|@unittest\.skip|\bpytest\.(mark\.(skip|xfail)|skip\s*\()|\bassume(True|False|That)\s*\(|@Disabled\b|@Ignore\b|#\[ignore\]|\bt\.Skip(f|Now)?\b|\bskip\s*:\s*true\b)' })
$removedAsserts = @($diff | Where-Object { $_ -match '^-(?!--).*\b(assert\w*|expect\s*\(|should\w*|t\.(Error|Fatal|Fail)\w*|fail\s*\()\b' })
$rustInlineTestEdit = @($diff | Where-Object { $_ -match '^[+-](?![+-]{2}).*(#\[cfg\(test\)\]|#\[test\])' })
$signals = @($testChanges) + @($skipChanges) + @($removedAsserts) + @($rustInlineTestEdit)
$testReport = @()
if ($signals.Count) { $testReport += $signals } else { $testReport += '(no modified/deleted test, skip, or removed-assertion signals; not a proof that assertions were preserved)' }
if ($addedTests.Count) { $testReport += '# added test files (not counted as risk signals):'; $testReport += $addedTests }
Save 'test-changes.txt' $testReport

$headEpochRaw = (Read-Git @('log', '-1', '--format=%ct')) -join ''
$headEpoch = 0L; [void][long]::TryParse($headEpochRaw, [ref]$headEpoch)
$evInfo = Collect-Evidence $headEpoch
$evidenceList = $evInfo.list; $staleEvidence = $evInfo.stale
if ($evidenceList.Count) { Write-Json (Join-Path $out 'evidence.json') $evidenceList }

$started = (Get-Date).ToString('o'); $code = 1; $isWin = ($env:OS -eq 'Windows_NT')
Push-Location -LiteralPath $Repo
try {
    $saved = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
        $raw = if ($isWin) { @(& cmd /d /c $cmd 2>&1) } else { @(& /bin/sh -c $cmd 2>&1) }
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $saved }
    Save 'output.txt' $raw
} finally { Pop-Location }
$finished = (Get-Date).ToString('o')

# Detect build-cache replays and 0-test runs without false-failing multi-target Rust (`cargo test` doc-tests = 0 when unit tests ran).
$outLines = @(@($raw) | ForEach-Object { "$_" })
$skipped = @($outLines | Where-Object { $_ -match '^> Task (\S*:)?(\w*[Tt]est|check) (UP-TO-DATE|FROM-CACHE|SKIPPED|NO-SOURCE)\s*$' })
$totals = @($outLines | Where-Object { $_ -match '^\d+ actionable tasks?: ' })
if (-not $skipped.Count -and $totals.Count -and -not @($totals | Where-Object { $_ -match '\bexecuted\b' }).Count) { $skipped = $totals }
if (-not $skipped.Count) {
    $goCached = @($outLines | Where-Object { $_ -match '^ok\s+\S+\s+\(cached\)' })
    $goNoFiles = @($outLines | Where-Object { $_ -match '^\?\s+\S+\s+\[no test files\]' })
    $goRan = @($outLines | Where-Object { $_ -match '^ok\s+\S+\s+\d' })
    if (($goCached.Count -or $goNoFiles.Count) -and -not $goRan.Count) {
        $skipped = @(if ($goCached.Count) { $goCached } else { $goNoFiles })
    }
}
if (-not $skipped.Count) {
    $cargoZero = @($outLines | Where-Object { $_ -match '\brunning 0 tests\b' })
    $cargoRan = @($outLines | Where-Object { $_ -match '\brunning [1-9]\d* tests\b' })
    if ($cargoZero.Count -and -not $cargoRan.Count) { $skipped = $cargoZero }
}
if (-not $skipped.Count) {
    $noTests = @($outLines | Where-Object {
        $_ -notmatch '^\s*(PASS|FAIL)\s+' -and (
            $_ -match '(Tests are skipped|No tests? (files? )?found|collected 0 items|^(#|ℹ)\s*(tests|pass)\s+0\s*$|Tests run:\s*0,|Total tests:\s*0\b|\[existing outputs match the cache\]|>>> FULL TURBO)' -or
            ($_ -match '^=+\s*\d+\s+skipped\b.*=+$' -and $_ -notmatch '\b[1-9]\d*\s+passed\b')
        )
    })
    if ($noTests.Count) { $skipped = $noTests }
}

$after = State; $afterHead = Head
Save 'status-after.txt' (@($after.tracked) + @($after.untracked | ForEach-Object { "?? $_" }) + @($after.hidden | ForEach-Object { "hidden: $_" }))
$changed = if (($after.tracked -join "`n") -cne ($before.tracked -join "`n")) { 'yes (tracked state changed)' } else { 'no' }
$why = @()
if ($code -ne 0) { $why += "exit $code" }
if ($skipped.Count) { $why += "check skipped or replayed from build cache, not run ($($skipped[0].Trim())); force a rerun such as --rerun-tasks" }
if ($before.dirty -or $after.dirty) { $why += 'uncommitted or hidden changes (before/after)' }
if ($changed -like 'yes*') { $why += 'the command changed tracked files' }
if ($afterHead -ne $head) { $why += 'HEAD changed during command' }
if ((Handoff-Hash) -ne $handoffHash) { $why += 'handoff changed during command' }
$why += @($gitErrors)
if ($diff.Count -eq 0) { $why += 'empty diff' }
$result = if ($why.Count) { 'FAIL ' + ($why -join '; ') } else { 'PASS' }

$baseTip = (Read-Git @('rev-parse', '--verify', '--quiet', '--end-of-options', "$($approved.baseRef)^{commit}") -Probe) -join ''
$isAncestor = $true
$savedAnc = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
try {
    & git -C $queryRepo merge-base --is-ancestor $approved.baseCommit HEAD 2>$null
    $isAncestor = ($LASTEXITCODE -eq 0)
} catch { $isAncestor = $false } finally { $ErrorActionPreference = $savedAnc }
$mergeCommits = @(Read-Git @('rev-list', '--merges', "$($approved.baseCommit)..HEAD") -Probe)
$specHash = Spec-Hash
$approvedSpecHash = if ($approved.PSObject.Properties['specHash']) { [string]$approved.specHash } else { '' }
$specChanged = if ($approvedSpecHash -and $specHash -ne $approvedSpecHash) { 'yes (SPEC.md changed since -Prepare)' } elseif (-not $approvedSpecHash -and $specHash) { 'yes (SPEC.md added since -Prepare)' } else { 'no' }

$summary = @(
    "ID: $Id", "REPO: $Repo", "COMMIT: $commit",
    "APPROVAL: $($approved.approval)", "HANDOFF-SHA256: $handoffHash",
    "SPEC-CHANGED: $specChanged",
    "DIRTY: $(if ($before.dirty) { "yes ($($before.hidden.Count) hidden, see status.txt)" } else { 'no' })",
    "CHANGED-BY-COMMAND: $changed",
    "BASE: $($approved.baseRef)", "BASE-COMMIT: $($approved.baseCommit)",
    "BASE-MOVED: $(if (-not $isAncestor) { 'WARN HEAD does not descend from pinned BASE-COMMIT' } elseif ($baseTip -and $baseTip -ne $approved.baseCommit) { 'yes; pinned base used, ask designer before incorporating new base changes' } else { 'no' })",
    "DIFF-LINES: $($diff.Count)$(if (-not $diff.Count) { '   WARN empty diff' })$(if ($mergeCommits.Count) { "   WARN $($mergeCommits.Count) merge commit(s) in range" })",
    "TEST-CHANGES: $($signals.Count)$(if ($signals.Count) { ' signal(s); inspect test-changes.txt and diff before accepting' })$(if ($addedTests.Count) { " (added tests: $($addedTests.Count))" })"
)
if ($evidenceList.Count) {
    $summary += "EVIDENCE: $($evidenceList.Count) file(s)$(if ($staleEvidence.Count) { "; WARN $($staleEvidence.Count) file(s) older than HEAD commit ($($staleEvidence -join ', '))" } else { ' (all current)' })"
}
$summary += @("COMMAND: $cmd", "STARTED: $started", "FINISHED: $finished", "EXIT: $code", "OUT: $out", "RESULT: $result")
Save 'summary.txt' $summary
$record = [ordered]@{
    kind=$(if ($Accept) { 'accept' } else { 'verify' })
    result=$result; commit=$head; approval=$approved.approval; handoffHash=$handoffHash; specHash=$specHash
    command=$cmd; run=$out; workerRun=$(if ($Accept) { $out } else { $out }); reviewedCommit=$ReviewedCommit
    reviewReport=$reviewInfo.path; reviewVerdict=$reviewInfo.verdict; evidence=$evidenceList
}
Write-Json (Join-Path $out 'run.json') $record
if (-not $Accept) {
    # Refresh compatibility view cleanly so stale files (e.g. an older evidence.json) never linger.
    foreach ($oldF in @(Get-ChildItem -LiteralPath $latest -File -ErrorAction SilentlyContinue)) {
        Remove-Item -LiteralPath $oldF.FullName -Force -ErrorAction SilentlyContinue
    }
    foreach ($file in Get-ChildItem -LiteralPath $out -File) {
        Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $latest $file.Name) -Force
    }
}
if ($Accept -and $result -eq 'PASS') { Write-Json $acceptedPath $record }
$summary | Write-Output
if ($why.Count -and $code -eq 0) { exit 1 }
exit $code
