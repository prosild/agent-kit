# Verify a Git task against the designer's approved handoff and pinned base.
# -Prepare: freeze criteria before implementation; no check command runs.
# Default: worker check. -Accept [-ReviewedCommit SHA]: designer rerun against the last worker PASS.
# -CheckAccepted: compare the current tip/criteria/clean tree immediately before submission.
# Manual/non-Git tasks use the evidence procedure in RUNBOOK 1, never an automatic PASS.
# Evidence: handoff/<ID>/verify/runs/<run>/ (immutable per run); verify/ is the latest view.
# Limits: current checkout, not a clean environment or a security boundary; remote PR head is checked separately.
param(
    [Parameter(Mandatory = $true)][string]$Id,
    [string]$Project = (Get-Location).Path, [string]$Repo = '', [string]$Base = '',
    [switch]$Prepare, [switch]$Accept, [switch]$CheckAccepted, [string]$ReviewedCommit = '', [string]$ReviewReport = ''
)
$ErrorActionPreference = 'Stop'
function Usage([string]$message) { Write-Output "ERROR $message"; exit 2 }
if ($Id -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]*$') { Usage "bad id: $Id" }
if ((@($Prepare, $Accept, $CheckAccepted) | Where-Object { $_ }).Count -gt 1) { Usage 'choose only one mode' }
if ($ReviewedCommit -and -not $Accept) { Usage '-ReviewedCommit is for -Accept only' }
if ($ReviewReport -and -not $Accept) { Usage '-ReviewReport is for -Accept only' }
if (-not (Test-Path -LiteralPath $Project -PathType Container)) { Usage "project not found: $Project" }
$Project = (Resolve-Path -LiteralPath $Project).Path
if ($Project -match '[\\/]\.worktrees([\\/]|$)') { Usage 'pass -Project <project folder> -Repo <worktree folder>' }
if (-not $Repo) { $Repo = $Project }
if (-not [IO.Path]::IsPathRooted($Repo)) { $Repo = Join-Path (Get-Location).Path $Repo }
$Repo = [IO.Path]::GetFullPath($Repo).TrimEnd('\', '/')
# A future worktree under the repository can be approved before the worker creates it.
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
function Write-Json([string]$path, $value) { [IO.File]::WriteAllText($path, ($value | ConvertTo-Json -Depth 8), $utf8) }
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
    # Any failed worker/designer rerun invalidates an earlier acceptance (RUNBOOK 1); -CheckAccepted only compares.
    if (-not $CheckAccepted) { Clear-Accepted }
    Write-Output "RESULT: FAIL $message"; exit 1
}
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$gitErrors = [Collections.Generic.List[string]]::new()
function Read-Git([string[]]$GitArgs, [switch]$Probe) {
    $saved = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
        $data = @(& git -C $queryRepo @GitArgs 2>$null)
        if ($LASTEXITCODE -eq 0) { return $data }
    } catch {} finally { $ErrorActionPreference = $saved }
    if (-not $Probe) { $gitErrors.Add("git failed: $($GitArgs -join ' ')") }
}
function Head { return ((Read-Git @('rev-parse', '--verify', 'HEAD')) -join '') }
function State {
    # --others is independent of status.showUntrackedFiles; both .gitignore and info/exclude apply.
    $tracked = @(Read-Git @('status', '--short', '--untracked-files=no'))
    $untracked = @(Read-Git @('ls-files', '--others', '--exclude-standard'))
    $hidden = @(Read-Git @('ls-files', '-v') | Where-Object { $_ -cmatch '^(S|[a-z]) ' })
    return [pscustomobject]@{ tracked=$tracked; untracked=$untracked; hidden=$hidden; dirty=($tracked.Count -or $untracked.Count -or $hidden.Count) }
}
function Handoff-Hash { return (Get-FileHash -LiteralPath $handoff -Algorithm SHA256).Hash }
$specPath = Join-Path $Project 'SPEC.md'
function Spec-Hash { if (Test-Path -LiteralPath $specPath -PathType Leaf) { return (Get-FileHash -LiteralPath $specPath -Algorithm SHA256).Hash }; return '' }
# Only the YAML-like header is read. Values are single-line and do not support inline comments.
$header = @{}; $lines = [IO.File]::ReadAllLines($handoff)
if ($lines.Count -and $lines[0].Trim() -eq '---') {
    for ($i = 1; $i -lt $lines.Count; $i++) {
        if ($lines[$i].Trim() -eq '---') { break }
        if ($lines[$i] -match '^(verify|base|review):\s*(.*)$') {
            if ($header.ContainsKey($Matches[1])) { Usage "duplicate header: $($Matches[1])" }
            $header[$Matches[1]] = $Matches[2].Trim()
        }
    }
}
$handoffHash = Handoff-Hash
$cmd = [string]$header['verify']
if ($cmd -match '^-?\s*(#.*)?$') { $cmd = '' }
if (-not $cmd) {
    $priorApproved = Read-Json $approvedPath
    if (-not $Prepare -and $priorApproved -and ($priorApproved.handoffHash -ne $handoffHash -or $priorApproved.command)) {
        Fail 'handoff changed since approval; report to designer'
    }
    if ($Accept -or $Prepare) { Clear-Accepted }
    Write-Output 'COMMAND: -'; Write-Output 'EXIT: not run (no verify command)'
    Write-Output 'RESULT: NONE (no verify command; use manual evidence)'; exit 3
}
$topOut = (Read-Git @('rev-parse', '--show-toplevel')) -join ''
if (-not $topOut) { Fail 'Git repository unavailable; use manual evidence for non-Git work' }
$topFull = [IO.Path]::GetFullPath($topOut).TrimEnd('\', '/')
if (-not $Prepare -and $topFull -ine $Repo) { Fail "Repo is not a repository or worktree root: $Repo (root is $topFull)" }
if ($Prepare -and $topFull -ine $queryRepo) {
    # A future worktree <root>\.worktrees\<id> whose .worktrees folder already exists (left by an earlier worktree).
    $wtDir = Join-Path $topFull '.worktrees'
    if (-not ($queryRepo -ieq $wtDir -and (Split-Path -Parent $Repo) -ieq $wtDir)) { Fail "Repo is not a repository or worktree root: $Repo (root is $topFull)" }
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
if ($approved.repo -ine $Repo -or $approved.common -ine $common) { Fail 'repository differs from approved handoff' }
if ($approved.handoffHash -ne $handoffHash -or $approved.command -cne $cmd) { Fail 'handoff changed since approval; report to designer' }
if ($Base -and $Base -cne $approved.baseRef) { Fail '-Base differs from approved base; report to designer' }
$head = Head
if ($CheckAccepted) {
    $accepted = Read-Json $acceptedPath
    $state = State
    if (-not $accepted -or $accepted.approval -ne $approved.approval -or $accepted.commit -ne $head -or $accepted.handoffHash -ne $handoffHash) { Fail 'no acceptance for this commit and handoff' }
    if ($state.dirty -or $gitErrors.Count) { Fail 'working tree is not clean or Git check failed' }
    Write-Output "COMMIT: $head"; Write-Output "ACCEPTED-RUN: $($accepted.run)"
    Write-Output 'RESULT: PASS (accepted tip unchanged; compare remote PR head separately)'; exit 0
}
$previous = Read-Json (Join-Path $latest 'run.json')
Clear-Accepted
$reviewReportPath = ''; $reviewVerdict = ''
if ($Accept) {
    if (-not $previous -or $previous.result -ne 'PASS' -or ($previous.kind -and $previous.kind -ne 'verify') -or $previous.approval -ne $approved.approval -or $previous.commit -ne $head) { Fail 'acceptance requires a prior worker PASS on this commit and approval' }
    if ($approved.review -eq 'critical' -and -not $ReviewedCommit) { Fail 'critical acceptance requires -ReviewedCommit from the review report' }
    if ($ReviewedCommit -and $ReviewedCommit -cne $head) { Fail 'reviewed commit differs from current HEAD' }
    if ($ReviewReport) {
        $rp = if ([IO.Path]::IsPathRooted($ReviewReport)) { $ReviewReport } else { Join-Path $Project $ReviewReport }
        $rp = [IO.Path]::GetFullPath($rp)
        if (-not (Test-Path -LiteralPath $rp -PathType Leaf)) { Fail "review report not found: $ReviewReport" }
        $reviewReportPath = $rp
        $firstNonEmpty = @([IO.File]::ReadAllLines($rp) | Where-Object { $_.Trim() }) | Select-Object -First 1
        if ($firstNonEmpty) { $reviewVerdict = $firstNonEmpty.Trim() }
        if ($reviewVerdict -match '(?i)(중단|수정\s*후\s*진행)') { Fail "review report verdict is not pass ($reviewVerdict)" }
    }
} else {
    $maxFailCfg = (Read-Git @('config', '--local', '--get', 'agentkit.maxVerifyFailures') -Probe) -join ''
    $maxFail = 5
    if ($maxFailCfg -match '^\d+$') { $maxFail = [int]$maxFailCfg }
    $runsDir = Join-Path $latest 'runs'
    if ($maxFail -gt 0 -and (Test-Path -LiteralPath $runsDir -PathType Container)) {
        $priorFails = 0
        foreach ($rf in Get-ChildItem -LiteralPath $runsDir -Directory -ErrorAction SilentlyContinue) {
            $rj = Read-Json (Join-Path $rf.FullName 'run.json')
            if ($rj -and $rj.approval -eq $approved.approval -and ([string]$rj.result).StartsWith('FAIL')) { $priorFails++ }
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
# A signal for human review, not a semantic proof of test strength and not an automatic failure.
$names = @(Read-Git @('diff', '--name-status', "$($approved.baseCommit)...HEAD"))
Save 'changed.txt' $names   # files this task changed (files.txt lists every tracked file)
$allTestFiles = @($names | Where-Object { $_ -match '(?i)(^|[/\\\t._-])(tests?|specs?|__tests__)([/\\._-]|$)' })
$addedTests = @($allTestFiles | Where-Object { $_ -match '^A\t' })
$testChanges = @($allTestFiles | Where-Object { $_ -notmatch '^A\t' })
$skipChanges = @($diff | Where-Object { $_ -match '^\+(?!\+\+).*(\.skip\b|\.only\b|\.todo\b|\b(xit|xdescribe|fit|fdescribe)\s*\(|@unittest\.skip|pytest\.mark\.(skip|xfail)|@Disabled\b|@Ignore\b|#\[ignore\]|\bt\.Skip(f|Now)?\b|\bskip\s*:\s*true\b)' })
$removedAsserts = @($diff | Where-Object { $_ -match '^-(?!--).*\b(assert\w*|expect\s*\(|should\w*)\b' })
$signals = @($testChanges) + @($skipChanges) + @($removedAsserts)
$testReport = @()
if ($signals.Count) { $testReport += $signals } else { $testReport += '(no modified/deleted test, skip, or removed-assertion signals; not a proof that assertions were preserved)' }
if ($addedTests.Count) { $testReport += '# added test files (not counted as risk signals):'; $testReport += $addedTests }
Save 'test-changes.txt' $testReport
$headEpochRaw = (Read-Git @('log', '-1', '--format=%ct')) -join ''
$headEpoch = 0L; [void][long]::TryParse($headEpochRaw, [ref]$headEpoch)
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
# A build tool that skips unchanged work or runs 0 tests exits 0 without executing checks: not run evidence.
$outLines = @(@($raw) | ForEach-Object { "$_" })
$skipped = @($outLines | Where-Object { $_ -match '^> Task (\S*:)?(\w*[Tt]est|check) (UP-TO-DATE|FROM-CACHE|SKIPPED|NO-SOURCE)\s*$' })
$totals = @($outLines | Where-Object { $_ -match '^\d+ actionable tasks?: ' })
if (-not $skipped.Count -and $totals.Count -and -not @($totals | Where-Object { $_ -match '\bexecuted\b' }).Count) { $skipped = $totals }
if (-not $skipped.Count) {
    $goCached = @($outLines | Where-Object { $_ -match '^ok\s+\S+\s+\(cached\)' })
    $goRan = @($outLines | Where-Object { $_ -match '^ok\s+\S+\s+\d' })
    if ($goCached.Count -and -not $goRan.Count) { $skipped = $goCached }
}
if (-not $skipped.Count) {
    $noTests = @($outLines | Where-Object { $_ -notmatch '^\s*(PASS|FAIL)\s+' -and $_ -match '(Tests are skipped|No tests? (files? )?found|collected 0 items|^# tests 0\s*$|\brunning 0 tests\b)' })
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
    "BASE-MOVED: $(if ($baseTip -and $baseTip -ne $approved.baseCommit) { 'yes; pinned base used, ask designer before incorporating new base changes' } else { 'no' })",
    "DIFF-LINES: $($diff.Count)$(if (-not $diff.Count) { '   WARN empty diff' })",
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
    command=$cmd; run=$out; reviewedCommit=$ReviewedCommit
    reviewReport=$reviewReportPath; reviewVerdict=$reviewVerdict; evidence=$evidenceList
}
Write-Json (Join-Path $out 'run.json') $record
# Compatibility view only: review reports must cite OUT, not these replaceable copies.
foreach ($file in Get-ChildItem -LiteralPath $out -File) { Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $latest $file.Name) -Force }
if ($Accept -and $result -eq 'PASS') { Write-Json $acceptedPath $record }
$summary | Write-Output
if ($why.Count -and $code -eq 0) { exit 1 }
exit $code
