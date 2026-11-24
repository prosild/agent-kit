<#
  agent-kit/cleanup.ps1 - list / delete agent session data (Claude, Codex, Antigravity, hc).

  A) Whole machine, by age
     List (deletes nothing):   cleanup.ps1 [-Days 30]
     Delete approved only:     cleanup.ps1 -Apply -Ids "1-5,9" [-Groups "codex,hc"]
  B) Only the sub-sessions one session started (hc parent tree), whatever agent runs them
     List:                     cleanup.ps1 -Parent $env:HC_TERMINAL_ID [-Logs "<extra agy log>,..."]
     Delete:                   cleanup.ps1 -Parent $env:HC_TERMINAL_ID -Apply -Groups "agy,claude,files,hc"
#>
[CmdletBinding()]
param(
  [int]$Days = 30,
  [switch]$Apply,
  [string]$Ids = '',
  [string]$Groups = '',
  [switch]$Permanent,
  [string]$Parent = '',
  [string]$Logs = '',
  [string]$Manifest = ''
)
$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false)
try {
  [Console]::InputEncoding = $utf8
  [Console]::OutputEncoding = $utf8
  $OutputEncoding = $utf8
} catch {}
$H = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$Sep = [IO.Path]::DirectorySeparatorChar
$IsWin = ($env:OS -eq 'Windows_NT') -or ([System.Environment]::OSVersion.Platform -eq 'Win32NT')
$MinAgeDays = 1
if (($PSBoundParameters.ContainsKey('Parent') -or $PSBoundParameters.ContainsKey('Logs')) -and -not ($Parent.Trim() -or $Logs.Trim())) {
  Write-Output 'ERROR -Parent/-Logs is empty. In PowerShell use $env:HC_TERMINAL_ID. Nothing was listed or deleted.'
  exit 2
}
$Mine = [bool]($Parent -or $Logs)
$ManifestGiven = [bool]$Manifest
if (-not $Manifest) {
  $tag = if ($Mine) { 'mine-' + ($(if ($Parent) { $Parent } else { 'logs' }) -replace '[^\w-]', '_') } else { 'last' }
  $tmpBase = if ($env:TEMP) { $env:TEMP } else { [IO.Path]::GetTempPath() }
  $Manifest = [IO.Path]::Combine($tmpBase, 'agent-cleanup', "$tag.json")
}
$AgyRoots = @(
  [IO.Path]::Combine($H, '.gemini', 'antigravity'),
  [IO.Path]::Combine($H, '.gemini', 'antigravity-cli'),
  [IO.Path]::Combine($H, '.gemini', 'antigravity-ide')
)
$AgyTemp = @('cache', 'crashes', 'log', 'scratch')

$AllowedRoots = @(
  [IO.Path]::Combine($H, '.claude', 'projects'),
  [IO.Path]::Combine($H, '.claude', 'file-history'),
  [IO.Path]::Combine($H, '.claude', 'session-env'),
  [IO.Path]::Combine($H, '.codex', 'sessions'),
  [IO.Path]::Combine($H, '.codex', 'archived_sessions')
)
foreach ($r in $AgyRoots) { foreach ($s in @('conversations', 'brain') + $AgyTemp) { $AllowedRoots += (Join-Path $r $s) } }
$Protected = @('bin', 'builtin', 'lib', 'memory', 'settings.json', 'mcp_oauth_tokens.json', 'oauth_creds.json',
               'auth.json', 'config.toml', 'installation_id', 'conversation_summaries.db')

function Test-Safe([string]$p) {
  $full = [IO.Path]::GetFullPath($p).TrimEnd('\', '/')
  foreach ($root in $AllowedRoots) {
    $rf = [IO.Path]::GetFullPath($root).TrimEnd('\', '/')
    if ($full.StartsWith($rf + $Sep, [StringComparison]::OrdinalIgnoreCase)) {
      $rest = $full.Substring($rf.Length + 1) -split '[\\/]'
      foreach ($seg in $rest) { if ($Protected -contains $seg.ToLower() -or $seg -like '*.pbtxt' -or $seg -like '*.sqlite*') { return $false } }
      if (Test-Path -LiteralPath $full -PathType Container) {
        foreach ($ch in @(Get-ChildItem -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue)) {
          $n = $ch.Name.ToLower()
          if ($Protected -contains $n -or $n -like '*.pbtxt' -or $n -like '*.sqlite*') { return $false }
        }
      }
      return $true
    }
  }
  return $false
}

function Get-Stat([string[]]$paths) {
  $newest = [datetime]::MinValue; $bytes = 0L
  foreach ($p in $paths) {
    if (-not (Test-Path -LiteralPath $p)) { continue }
    $it = Get-Item -LiteralPath $p -Force
    if ($it.PSIsContainer) {
      $files = @(Get-ChildItem -LiteralPath $p -Recurse -File -Force -ErrorAction SilentlyContinue)
      if ($files.Count -eq 0 -and $it.LastWriteTime -gt $newest) { $newest = $it.LastWriteTime }
      foreach ($f in $files) { $bytes += $f.Length; if ($f.LastWriteTime -gt $newest) { $newest = $f.LastWriteTime } }
    } else {
      $bytes += $it.Length; if ($it.LastWriteTime -gt $newest) { $newest = $it.LastWriteTime }
    }
  }
  return @{ Newest = $newest; Bytes = $bytes }
}

function Get-Hc {
  $c = Get-Command hc -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  if ($IsWin -and $env:LOCALAPPDATA) {
    $p = [IO.Path]::Combine($env:LOCALAPPDATA, 'Programs', 'herdr-core', 'hc.exe')
    if (Test-Path -LiteralPath $p) { return $p }
  }
  return $null
}

function Test-AcceptedReviewReport([string]$p, [string]$root) {
  if (-not $p -or -not $root) { return $false }
  $hDir = Join-Path $root 'handoff'
  if (-not (Test-Path -LiteralPath $hDir -PathType Container)) { return $false }
  $full = [IO.Path]::GetFullPath($p).TrimEnd('\', '/')
  foreach ($acc in @(Get-ChildItem -LiteralPath $hDir -Directory -ErrorAction SilentlyContinue)) {
    $af = Join-Path $acc.FullName 'accepted.json'
    if (-not (Test-Path -LiteralPath $af -PathType Leaf)) { continue }
    try {
      $aj = [IO.File]::ReadAllText($af, [Text.Encoding]::UTF8) | ConvertFrom-Json
      $rp = if ($aj -and $aj.PSObject.Properties['reviewReport']) { [string]$aj.reviewReport } else { '' }
      if (-not $rp) { continue }
      $rf = [IO.Path]::GetFullPath($(if ([IO.Path]::IsPathRooted($rp)) { $rp } else { Join-Path $root $rp })).TrimEnd('\', '/')
      if ($rf -ieq $full -or $rf.StartsWith($full + $Sep, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    } catch {}
  }
  return $false
}

function Format-Size([long]$b) {
  if ($b -ge 1GB) { return '{0:N1}GB' -f ($b / 1GB) }
  if ($b -ge 1MB) { return '{0:N1}MB' -f ($b / 1MB) }
  if ($b -ge 1KB) { return '{0:N0}KB' -f ($b / 1KB) }
  return "${b}B"
}

function New-Item2($group, $label, $paths, $hcAddr, [bool]$explicit, $root = $null) {
  $st = Get-Stat $paths
  return [pscustomobject]@{ Id = 0; Group = $group; Label = $label; Paths = @($paths); Hc = $hcAddr; Explicit = $explicit; Root = $root
                            Bytes = $st.Bytes; Newest = $(if ($paths.Count) { $st.Newest.ToString('o') } else { '' }) }
}

# Temp files of a child run: inside the run's working folder, starting with sub-/agy- or worker log task-*.log.
function Test-SafeFile([string]$p, [string]$root) {
  if (-not $root) { return $false }
  $full = [IO.Path]::GetFullPath($p).TrimEnd('\', '/'); $rf = [IO.Path]::GetFullPath($root).TrimEnd('\', '/')
  if (-not $full.StartsWith($rf + $Sep, [StringComparison]::OrdinalIgnoreCase)) { return $false }
  $leaf = Split-Path $full -Leaf
  return ($leaf -like 'sub-*' -or $leaf -like 'agy-*' -or $leaf -match '^task-[a-z0-9_.-]+\.log$')
}

function Find-ClaudeTranscript([string]$cwd, [string]$prompt, $createdMs) {
  if (-not $cwd -or -not $prompt) { return @() }
  $projRoot = [IO.Path]::Combine($H, '.claude', 'projects')
  $dir = Join-Path $projRoot ($cwd.TrimEnd('\', '/') -replace '[^A-Za-z0-9]', '-')
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) { return @() }
  $since = if ($createdMs) { [DateTimeOffset]::FromUnixTimeMilliseconds([long]$createdMs).LocalDateTime.AddMinutes(-2) } else { [datetime]::MinValue }
  $out = @(); $hits = 0
  foreach ($f in @(Get-ChildItem -LiteralPath $dir -Filter '*.jsonl' -File | Where-Object { $_.LastWriteTime -ge $since })) {
    $first = $null
    foreach ($line in @(Get-Content -LiteralPath $f.FullName -TotalCount 40 -Encoding UTF8)) {
      try { $o = $line | ConvertFrom-Json } catch { continue }
      if ($o.type -eq 'user' -and $o.message) {
        $c = $o.message.content
        $first = if ($c -is [string]) { $c } else { (@($c) | ForEach-Object { [string]$_.text }) -join '' }
        break
      }
    }
    if ($first -and $first.Trim() -eq $prompt.Trim()) {
      $hits++
      $out += $f.FullName
      $sid = $f.BaseName
      foreach ($x in @((Join-Path $dir $sid), [IO.Path]::Combine($H, '.claude', 'file-history', $sid), [IO.Path]::Combine($H, '.claude', 'session-env', $sid))) {
        if (Test-Path -LiteralPath $x) { $out += $x }
      }
    }
  }
  if ($hits -gt 1) { Write-Warning "$hits Claude conversations in $dir share this first prompt; none is listed (remove by hand if wanted)"; return @() }
  return @($out | Where-Object { Test-Safe $_ })
}

# $true = keep: tracked by Git, or Git could not answer. Uses relative leaf name so symlinked roots never fail with exit 128.
function Test-GitTracked([string]$p) {
  $isContainer = (Test-Path -LiteralPath $p -PathType Container)
  $dir = if ($isContainer) { $p } else { Split-Path $p -Parent }
  $d = [IO.Path]::GetFullPath($dir); $inRepo = $false
  while ($d) {
    if (Test-Path -LiteralPath (Join-Path $d '.git')) { $inRepo = $true; break }
    $up = Split-Path $d -Parent; if (-not $up -or $up -eq $d) { break }; $d = $up
  }
  if (-not $inRepo) { return $false }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return $true }
  $ErrorActionPreference = 'Continue'
  $targetArg = if ($isContainer) { '.' } else { ":(literal)$(Split-Path $p -Leaf)" }
  $out = & git -C $dir ls-files -- $targetArg 2>$null
  if ($LASTEXITCODE -ne 0) { return $true }
  return [bool]$out
}

function Get-AgyPaths([string]$root, [string]$id) {
  $ps = @((Join-Path (Join-Path $root 'brain') $id))
  $convDir = Join-Path $root 'conversations'
  if (Test-Path -LiteralPath $convDir) {
    $ps += Get-ChildItem -LiteralPath $convDir -Filter "$id.db*" -File | ForEach-Object { $_.FullName }
  }
  return @($ps | Where-Object { (Test-Path -LiteralPath $_) -and (Test-Safe $_) })
}

function Save-And-Print($items, [string]$title) {
  $order = @('claude', 'codex', 'agy', 'agy-temp', 'files', 'hc')
  $items = @(foreach ($g in $order) { $items | Where-Object { $_.Group -eq $g } })
  $i = 0; foreach ($it in $items) { $i++; $it.Id = $i }
  $dir = Split-Path $Manifest -Parent
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
  $jsonText = ([pscustomobject]@{ Created = (Get-Date).ToString('o'); Days = $Days; Parent = $Parent; Items = @($items) } | ConvertTo-Json -Depth 6)
  [IO.File]::WriteAllText($Manifest, $jsonText + "`n", $utf8)

  Write-Output "== $title (nothing deleted). Manifest: $Manifest"
  Write-Output ''
  Write-Output 'GROUP SUMMARY'
  foreach ($g in ($items | Group-Object Group)) {
    $ids2 = $g.Group | ForEach-Object { $_.Id }
    $dates = @($g.Group | Where-Object { $_.Newest } | ForEach-Object { ([datetime]$_.Newest).ToString('yyyy-MM-dd') } | Sort-Object)
    $range = if ($dates.Count) { "$($dates[0]) ~ $($dates[-1])" } else { '-' }
    $sum = ($g.Group | Measure-Object Bytes -Sum).Sum
    Write-Output ("  {0,-9} {1,4} items  {2,8}  ids {3}-{4}  last-modified {5}" -f $g.Name, $g.Count, (Format-Size $sum), ($ids2 | Select-Object -First 1), ($ids2 | Select-Object -Last 1), $range)
  }
  $total = ($items | Measure-Object Bytes -Sum).Sum
  Write-Output ("  TOTAL     {0,4} items  {1,8}" -f $items.Count, (Format-Size $total))
  Write-Output ''
  Write-Output 'ITEMS'
  foreach ($it in $items) {
    $d = if ($it.Newest) { ([datetime]$it.Newest).ToString('yyyy-MM-dd') } else { '-' }
    Write-Output ("  {0,4}  {1,-9} {2,8}  {3}  {4}" -f $it.Id, $it.Group, (Format-Size $it.Bytes), $d, $it.Label)
  }
}

# ---------------- LIST A: whole machine by age ----------------
function Invoke-List {
  $cutoff = (Get-Date).AddDays(-[Math]::Max($Days, $MinAgeDays))
  $items = New-Object System.Collections.ArrayList
  $add = {
    param($group, $label, $paths)
    $paths = @($paths | Where-Object { $_ -and (Test-Path -LiteralPath $_) -and (Test-Safe $_) })
    if ($paths.Count -eq 0) { return }
    $it = New-Item2 $group $label $paths $null $false
    if ([datetime]$it.Newest -ge $cutoff) { return }
    [void]$items.Add($it)
  }

  $proj = [IO.Path]::Combine($H, '.claude', 'projects')
  if (Test-Path -LiteralPath $proj) {
    foreach ($pd in Get-ChildItem -LiteralPath $proj -Directory -Force) {
      foreach ($j in Get-ChildItem -LiteralPath $pd.FullName -Filter '*.jsonl' -File -Force) {
        $id = $j.BaseName
        & $add 'claude' "$($pd.Name) / $id" @(
          $j.FullName,
          (Join-Path $pd.FullName $id),
          [IO.Path]::Combine($H, '.claude', 'file-history', $id),
          [IO.Path]::Combine($H, '.claude', 'session-env', $id)
        )
      }
    }
  }

  foreach ($sub in @('sessions', 'archived_sessions')) {
    $d = [IO.Path]::Combine($H, '.codex', $sub)
    if (-not (Test-Path -LiteralPath $d)) { continue }
    foreach ($f in Get-ChildItem -LiteralPath $d -Recurse -File -Force) {
      & $add 'codex' ("$sub/" + $f.FullName.Substring($d.Length + 1).Replace('\', '/')) @($f.FullName)
    }
  }

  foreach ($r in $AgyRoots) {
    if (-not (Test-Path -LiteralPath $r)) { continue }
    $rn = Split-Path $r -Leaf
    $ids = @()
    $convDir = Join-Path $r 'conversations'
    $brainDir = Join-Path $r 'brain'
    if (Test-Path -LiteralPath $convDir) { $ids += Get-ChildItem -LiteralPath $convDir -Filter '*.db' -File | ForEach-Object { $_.BaseName } }
    if (Test-Path -LiteralPath $brainDir) { $ids += Get-ChildItem -LiteralPath $brainDir -Directory | ForEach-Object { $_.Name } }
    foreach ($id in ($ids | Sort-Object -Unique)) { & $add 'agy' "$rn / $id" (Get-AgyPaths $r $id) }
    foreach ($t in $AgyTemp) {
      $tDir = Join-Path $r $t
      if (-not (Test-Path -LiteralPath $tDir)) { continue }
      $old = @(Get-ChildItem -LiteralPath $tDir -Force | Where-Object { (Get-Stat @($_.FullName)).Newest -lt $cutoff } | ForEach-Object { $_.FullName })
      if ($old.Count -gt 0) { & $add 'agy-temp' "$rn / $t ($($old.Count) entries)" $old }
    }
  }

  $hc = Get-Hc
  if ($hc) {
    try {
      $ls = (& $hc ls --all) -join "`n" | ConvertFrom-Json
      foreach ($t in @($ls.terminals | Where-Object { $_.state -eq 'finished' })) {
        [void]$items.Add((New-Item2 'hc' ("{0} {1} {2} [{3}]" -f $t.address, $t.agent, $t.name, $t.where).Trim() @() $t.address $false))
      }
    } catch { Write-Warning "hc ls failed: $($_.Exception.Message)" }
  }
  Save-And-Print $items "Candidates older than $Days days"
}

# ---------------- LIST B: child sessions ----------------
function Invoke-ListMine {
  $items = New-Object System.Collections.ArrayList
  $logMap = [ordered]@{}
  $fileSet = [ordered]@{}
  $addFile = {
    param($p, $root)
    if (-not $p) { return }
    if (-not [IO.Path]::IsPathRooted($p)) { $p = Join-Path $root $p }
    $full = [IO.Path]::GetFullPath($p)
    $parent = Split-Path $full -Parent
    if ((Split-Path $parent -Leaf) -ieq 'handoff') { $root = Split-Path $parent -Parent }
    $fileSet[$full] = $root
  }
  $hc = Get-Hc
  if ($Parent) {
    if (-not $hc) { throw 'hc not found' }
    $all = @(((& $hc ls --all) -join "`n" | ConvertFrom-Json).terminals)
    $queue = New-Object System.Collections.Queue; $queue.Enqueue($Parent)
    while ($queue.Count -gt 0) {
      $p = $queue.Dequeue()
      foreach ($t in @($all | Where-Object { $_.parent -eq $p })) {
        $g = $null
        try { $g = (& $hc get $t.address) -join "`n" | ConvertFrom-Json } catch { Write-Warning "hc get $($t.address) failed: $($_.Exception.Message)"; continue }
        $argv = @($g.argv); $cwd = $g.cwd
        $st = if ($g.status -and $g.status.state) { [string]$g.status.state } else { '-' }
        if ($t.state -eq 'live' -and $st -in @('working', 'blocked')) { Write-Output ("KEEP  terminal {0} {1} {2} (live and {3}: an agent is mid-task)" -f $t.address, $t.agent, $t.name, $st); continue }
        $queue.Enqueue($t.address)
        for ($k = 0; $k -lt $argv.Count; $k++) {
          $a = [string]$argv[$k]; $v = if ($k -lt $argv.Count - 1) { [string]$argv[$k + 1] } else { '' }
          $lp = $null
          if ($a -eq '--log-file') { $lp = $v; & $addFile $v $cwd }
          elseif ($a -eq '-Report') { $lp = "$v.log"; & $addFile $v $cwd; & $addFile "$v.log" $cwd; & $addFile "$v.err.log" $cwd }
          elseif ($a -eq '-Task') { & $addFile $v $cwd }
          elseif ($a -match 'Read (.+?) and follow it') { & $addFile ($Matches[1].Trim('"', "'", '`')) $cwd }
          if ($lp) {
            if (-not [IO.Path]::IsPathRooted($lp)) { $lp = Join-Path $cwd $lp }
            $logMap[[IO.Path]::GetFullPath($lp)] = $t.address
          }
        }
        $exe = ([string]$argv[0]) -replace '^.*[\\/]', '' -replace '\.(exe|cmd|ps1)$', ''
        if ($exe -ieq 'claude') {
          $tr = @(Find-ClaudeTranscript $cwd ([string]$argv[-1]) $g.created_ms)
          if ($tr.Count) { [void]$items.Add((New-Item2 'claude' ("{0} / {1} (child {2} {3})" -f (Split-Path (Split-Path $tr[0] -Parent) -Leaf), [IO.Path]::GetFileNameWithoutExtension($tr[0]), $t.address, $t.name) $tr $null $true)) }
          else { Write-Output ("NOTE  claude conversation of {0} {1}: transcript not found (prompt/cwd did not match)" -f $t.address, $t.name) }
        } elseif ($exe -ieq 'codex') {
          Write-Output ("NOTE  codex conversation of {0} {1}: not located automatically yet. Find it with 'codex resume' if wanted." -f $t.address, $t.name)
        }
        $state = if ($t.state -eq 'live') { "LIVE status=$st" } else { 'finished' }
        [void]$items.Add((New-Item2 'hc' ("{0} {1} {2} [{3}]" -f $t.address, $t.agent, $t.name, $state).Trim() @() $t.address $true))
      }
    }
  }
  foreach ($l in ($Logs -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
    $lf = [IO.Path]::GetFullPath($l); $logMap[$lf] = 'manual'
    $root = Split-Path $lf -Parent; if ((Split-Path $root -Leaf) -eq 'handoff') { $root = Split-Path $root -Parent }
    & $addFile $lf $root
  }

  $kw = -join [char[]](0xBCF4, 0xACE0, 0x20, 0xD30C, 0xC77C)
  foreach ($f in @($fileSet.Keys)) {
    if ($f -notlike '*.md' -or -not (Test-Path -LiteralPath $f -PathType Leaf)) { continue }
    foreach ($mm in [regex]::Matches(([IO.File]::ReadAllText($f, [Text.Encoding]::UTF8)), [regex]::Escape($kw) + ':\s*`?([^\r\n`]+)')) {
      $rp = $mm.Groups[1].Value.Trim().Trim('"', "'", '`')
      if (-not $rp -or $rp -match '[<>|?*]') { continue }
      $runRoot = $fileSet[$f]; $stem = [IO.Path]::GetFileNameWithoutExtension($f)
      try { $rf = [IO.Path]::GetFullPath($(if ([IO.Path]::IsPathRooted($rp)) { $rp } else { Join-Path $runRoot $rp })) } catch { continue }
      $ownName = ((Split-Path $rf -Leaf) -ieq "$stem-report.md") -or ((Split-Path (Split-Path $rf -Parent) -Leaf) -ieq $stem)
      if (-not $rf.StartsWith($runRoot.TrimEnd('\', '/') + $Sep, [StringComparison]::OrdinalIgnoreCase) -or -not $ownName) {
        Write-Output ("NOTE  report path in {0} is outside this run or another stem, not listed: {1}" -f (Split-Path $f -Leaf), $rp); continue
      }
      try { & $addFile $rf $runRoot } catch {}
    }
  }
  foreach ($f in @($fileSet.Keys)) {
    $leaf = Split-Path $f -Leaf; $dir = Split-Path $f -Parent
    $mm = [regex]::Match($leaf, '^((?:sub|agy)-[a-z0-9_.-]+?-(?:review|research|flash)-\d+)(?:-report)?(?:\.md|\.log|\.md\.log|\.md\.err\.log)?$')
    if (-not $mm.Success -or -not (Test-Path -LiteralPath $dir)) { continue }
    $stem = $mm.Groups[1].Value
    $sib = '^' + [regex]::Escape($stem) + '(?:\.md|\.log|-report\.md(?:\.log|\.err\.log)?)?$'
    foreach ($s in Get-ChildItem -LiteralPath $dir -Force | Where-Object { $_.Name -cmatch $sib }) {
      & $addFile $s.FullName $fileSet[$f]
    }
  }

  $seen = @{}
  foreach ($lp in $logMap.Keys) {
    if (-not (Test-Path -LiteralPath $lp)) { Write-Warning "log not found: $lp"; continue }
    $convIds = @(Select-String -LiteralPath $lp -Pattern 'Created conversation ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})' -AllMatches |
             ForEach-Object { $_.Matches } | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
    if ($convIds.Count -eq 0) { Write-Warning "no conversation id in log: $lp" }
    foreach ($id in $convIds) {
      if ($seen[$id]) { continue }; $seen[$id] = $true
      foreach ($r in $AgyRoots) {
        $ps = Get-AgyPaths $r $id
        if ($ps.Count -gt 0) { [void]$items.Add((New-Item2 'agy' ("{0} / {1} (log: {2})" -f (Split-Path $r -Leaf), $id, (Split-Path $lp -Leaf)) $ps $null $true)) }
      }
    }
  }
  foreach ($f in $fileSet.Keys) {
    if (-not (Test-Path -LiteralPath $f)) { continue }
    $root = $fileSet[$f]
    if (-not (Test-SafeFile $f $root)) { Write-Output "KEEP  $f (outside the run folder or not a sub-session temp/log file)"; continue }
    if (Test-GitTracked $f) { Write-Output "KEEP  $f (tracked by git, or git could not tell)"; continue }
    if (Test-AcceptedReviewReport $f $root) { Write-Output "KEEP  $f (referenced by accepted.json)"; continue }
    [void]$items.Add((New-Item2 'files' $f.Substring([IO.Path]::GetFullPath($root).TrimEnd('\', '/').Length + 1) @($f) $null $true $root))
  }
  Write-Output ("Scanned {0} agy log(s) from {1}." -f $logMap.Count, $(if ($Parent) { "hc children of $Parent" } else { '-Logs' }))
  Save-And-Print $items 'Sub-sessions of this session'
}

# ---------------- APPLY ----------------
function Expand-Ids([string]$s) {
  $out = @()
  foreach ($part in ($s -split ',')) {
    $p = $part.Trim(); if (-not $p) { continue }
    if ($p -match '^(\d+)-(\d+)$') { $out += [int]$Matches[1]..[int]$Matches[2] }
    elseif ($p -match '^\d+$') { $out += [int]$p }
    else { throw "Bad id: $p" }
  }
  return $out
}

function Remove-One([string]$p) {
  $isDir = (Get-Item -LiteralPath $p -Force).PSIsContainer
  if ($Permanent) { Remove-Item -LiteralPath $p -Recurse -Force; return }
  if ($IsWin) {
    Add-Type -AssemblyName Microsoft.VisualBasic
    $ui = [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs
    $rc = [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin
    if ($isDir) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, $ui, $rc) }
    else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, $ui, $rc) }
    return
  }
  $trash = if (Test-Path -LiteralPath (Join-Path $H '.Trash')) { Join-Path $H '.Trash' } else { [IO.Path]::Combine($H, '.local', 'share', 'Trash', 'files') }
  if (-not (Test-Path -LiteralPath $trash)) { New-Item -ItemType Directory -Path $trash -Force | Out-Null }
  $dest = Join-Path $trash ("$(Split-Path $p -Leaf)-$([guid]::NewGuid().ToString('N').Substring(0,8))")
  Move-Item -LiteralPath $p -Destination $dest -Force
}

function Get-TerminalState([string]$hc, [string]$addr) {
  $ErrorActionPreference = 'Continue'
  $raw = @(& $hc get $addr 2>$null); $code = $LASTEXITCODE
  if ($code -ne 0) { throw "state unreadable (hc get exit $code)" }
  try { $g = ($raw -join "`n") | ConvertFrom-Json } catch { throw 'state unreadable (hc get output is not JSON)' }
  if (-not $g -or ([string]$g.state) -notin @('live', 'finished')) { throw 'state unreadable (no terminal state in hc get output)' }
  if ($g.state -eq 'live' -and -not ($g.status -and $g.status.state)) { throw 'state unreadable (live terminal without a status)' }
  if ($g.state -eq 'live' -and ([string]$g.status.state) -in @('working', 'blocked')) { throw "now $($g.status.state)" }
  return $g
}

function Remove-Terminal([string]$hc, [string]$addr) {
  $g = Get-TerminalState $hc $addr
  if ($g.state -eq 'live') { & $hc kill $addr | Out-Null; if ($LASTEXITCODE -ne 0) { throw "hc kill exit $LASTEXITCODE" } }
  for ($n = 0; $n -lt 10; $n++) {
    $out = & $hc rm $addr 2>&1
    if ($LASTEXITCODE -eq 0) { return }
    Start-Sleep -Seconds 1
  }
  throw "hc rm: $out"
}

function Invoke-Apply {
  if (-not (Test-Path -LiteralPath $Manifest)) { throw "No manifest. Run the list mode first." }
  $rawManifest = [IO.File]::ReadAllText($Manifest, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
  $m = $rawManifest | ConvertFrom-Json
  if (-not $Mine -and -not $ManifestGiven) {
    $mt = (Get-Item -LiteralPath $Manifest).LastWriteTime
    $newer = @(Get-ChildItem -LiteralPath (Split-Path $Manifest -Parent) -Filter 'mine-*.json' -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt $mt })
    if ($newer.Count) { throw "A sub-session list ($($newer[0].Name)) is newer than the whole-PC list. Pass the same -Parent (or -Logs) as that list, or run the whole-PC list again." }
  }
  if ($Mine -and $Parent -and [string]$m.Parent -and [string]$m.Parent -ne $Parent) {
    throw "Manifest parent ($($m.Parent)) differs from -Parent ($Parent). Run the list mode for $Parent first."
  }
  if (((Get-Date) - [datetime]$m.Created).TotalHours -gt 24) { throw "Manifest older than 24h. Run the list mode again." }
  $want = @(Expand-Ids $Ids)
  $gs = @($Groups -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  if (-not $Mine -and ($gs -contains 'files')) { throw "Group 'files' needs -Parent (or -Logs): this looks like a sub-session cleanup without -Parent." }
  $sel = @($m.Items | Where-Object { $want -contains [int]$_.Id -or $gs -contains $_.Group })
  if ($sel.Count -eq 0) { throw "Nothing selected. Pass -Ids and/or -Groups." }
  $sel = @($sel | Where-Object { $_.Hc }) + @($sel | Where-Object { -not $_.Hc -and $_.Group -ne 'files' }) +
         @($sel | Where-Object { $_.Group -eq 'files' -and $_.Label -notlike '*.log' }) + @($sel | Where-Object { $_.Group -eq 'files' -and $_.Label -like '*.log' })
  $hc = Get-Hc
  if ($Mine) {
    foreach ($t in @($m.Items | Where-Object { $_.Hc })) {
      $why = $null
      if (-not $hc) { $why = 'hc not found' }
      else { try { $null = Get-TerminalState $hc $t.Hc } catch { $why = $_.Exception.Message } }
      if ($why) {
        Write-Output ("STOP  {0,4} {1}: {2} - nothing removed; run the list again later" -f $t.Id, $t.Label, $why)
        Write-Output ''; Write-Output 'DONE ok=0 skip=0 fail=1  nothing removed'; exit 1
      }
    }
  }
  $guard = (Get-Date).AddDays(-$MinAgeDays)
  $freed = 0L; $ok = 0; $skip = 0; $fail = 0; $settle = $false
  foreach ($it in $sel) {
    try {
      if ($it.Hc) {
        if (-not $hc) { throw 'hc not found' }
        try { Remove-Terminal $hc $it.Hc }
        catch {
          if ($Mine) {
            $fail++; Write-Output ("STOP  {0,4} {1}: {2} - nothing else removed; run the list again later" -f $it.Id, $it.Label, $_.Exception.Message); break
          }
          throw
        }
        Write-Output ("OK    {0,4} {1}" -f $it.Id, $it.Label); $ok++; $settle = $true; continue
      }
      if ($settle) { Start-Sleep -Seconds 5; $settle = $false }
      $paths = @($it.Paths | Where-Object { $_ -and (Test-Path -LiteralPath $_) })
      if ($paths.Count -eq 0) { Write-Output ("SKIP  {0,4} {1} (already gone)" -f $it.Id, $it.Label); $skip++; continue }
      foreach ($p in $paths) {
        if ($it.Group -eq 'files') {
          if (-not (Test-SafeFile $p $it.Root)) { throw "unsafe path refused: $p" }
          if (Test-GitTracked $p) { throw "tracked by git (or git could not tell), kept: $p" }
          if (Test-AcceptedReviewReport $p $it.Root) { throw "referenced by accepted.json, kept: $p" }
        } elseif (-not (Test-Safe $p)) { throw "unsafe path refused: $p" }
      }
      $st = Get-Stat $paths
      if (-not $it.Explicit -and ($st.Newest -gt ([datetime]$it.Newest).AddSeconds(1) -or $st.Newest -gt $guard)) {
        Write-Output ("SKIP  {0,4} {1} (modified since listing)" -f $it.Id, $it.Label); $skip++; continue
      }
      foreach ($p in $paths) { Remove-One $p }
      $freed += $st.Bytes; $ok++
      Write-Output ("OK    {0,4} {1,8} {2}" -f $it.Id, (Format-Size $st.Bytes), $it.Label)
    } catch {
      $fail++; Write-Output ("FAIL  {0,4} {1}: {2}" -f $it.Id, $it.Label, $_.Exception.Message)
    }
  }
  $where = if ($Permanent) { 'permanently deleted' } elseif ($IsWin) { 'moved to Recycle Bin' } else { 'moved to Trash' }
  Write-Output ''
  Write-Output ("DONE ok={0} skip={1} fail={2}  {3} {4}" -f $ok, $skip, $fail, (Format-Size $freed), $where)
  if ($fail -gt 0) { exit 1 }
}

if ($Apply) { Invoke-Apply } elseif ($Mine) { Invoke-ListMine } else { Invoke-List }
