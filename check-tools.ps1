# Compares the installed agent tool versions with the versions this kit was last checked against (tool-versions.txt).
# The vendors update their CLIs often; behaviour the kit relies on (modes, hooks, options, model names) can change.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File <agent-kit>/check-tools.ps1 [-Accept]
#   prints one line:  TOOLS: OK   or   TOOLS: CHANGED agy 1.5.6 -> 1.5.7; ... (tell the user and continue; re-check only when the user asks)
#   -Accept  records the installed versions as checked (run it after the re-check in RUNBOOK section 14).
# init.ps1 prints this line too, so a change is noticed without anyone having to remember to look.
param([switch]$Accept)

$ErrorActionPreference = 'Continue'
$baseFile  = Join-Path $PSScriptRoot 'tool-versions.txt'
$localFile = if ($env:AGENTKIT_TOOL_VERSIONS_FILE) { $env:AGENTKIT_TOOL_VERSIONS_FILE } else { Join-Path $PSScriptRoot 'tool-versions.local.txt' }
$readFile  = if (Test-Path -LiteralPath $localFile -PathType Leaf) { $localFile } else { $baseFile }
function Get-Ver([string]$exe, [string]$fallback = '') {
    try {
        $cmd = Get-Command $exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        $src = if ($cmd -and $cmd.Source) { $cmd.Source } elseif ($fallback -and (Test-Path -LiteralPath $fallback -PathType Leaf -ErrorAction SilentlyContinue)) { $fallback } else { '' }
        if (-not $src) { return 'not-found' }
        $out = (& $src --version 2>$null | Out-String)
        if ($LASTEXITCODE -ne 0) { return 'unknown' }
        if ($out -match '\d+\.\d+\.\d+([-+][0-9A-Za-z.+-]+)?') { return $Matches[0] }
        return 'unknown'
    } catch { return 'unknown' }
}
$agyFallback   = if ($env:LOCALAPPDATA) { [IO.Path]::Combine($env:LOCALAPPDATA, 'agy', 'bin', 'agy.exe') } else { '' }
$codexFallback = if ($env:LOCALAPPDATA) { [IO.Path]::Combine($env:LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe') } else { '' }
$hcFallback    = if ($env:LOCALAPPDATA) { [IO.Path]::Combine($env:LOCALAPPDATA, 'Programs', 'herdr-core', 'hc.exe') } else { '' }
$now = [ordered]@{
    agy    = Get-Ver 'agy' $agyFallback
    claude = Get-Ver 'claude'
    codex  = Get-Ver 'codex' $codexFallback
    hc     = Get-Ver 'hc' $hcFallback
}
$old = @{}
if (Test-Path -LiteralPath $readFile -PathType Leaf) { foreach ($l in [IO.File]::ReadAllLines($readFile)) { $p = $l.Trim() -split '\s+'; if ($p.Count -ge 2) { $old[$p[0]] = $p[1] } } }
if ($Accept) {
    $rec = [ordered]@{}
    foreach ($k in $now.Keys) {
        $rec[$k] = if ($now[$k] -eq 'unknown' -and $old[$k]) { $old[$k] } else { $now[$k] }
    }
    try { [IO.File]::WriteAllLines($localFile, [string[]]@($rec.Keys | ForEach-Object { "$_ $($rec[$_])" }), [Text.UTF8Encoding]::new($false)) }
    catch { Write-Output "TOOLS: record FAILED ($($_.Exception.Message))"; exit 1 }
    Write-Output ("TOOLS: recorded " + (($rec.Keys | ForEach-Object { "$_ $($rec[$_])" }) -join ', '))
    exit 0
}
# Harness hook configuration integrity check (AgentShield-style check for unresolved <agent-kit> or missing guard.mjs).
$homeDir = if ($env:AGENTKIT_HOME) { $env:AGENTKIT_HOME } elseif ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$hookIssues = @()
if ($homeDir) {
    $hookFiles = [ordered]@{
        claude = [IO.Path]::Combine($homeDir, '.claude', 'settings.json')
        codex  = [IO.Path]::Combine($homeDir, '.codex', 'hooks.json')
        agy    = [IO.Path]::Combine($homeDir, '.gemini', 'config', 'hooks.json')
    }
    foreach ($hk in $hookFiles.Keys) {
        $hp = $hookFiles[$hk]
        if (-not (Test-Path -LiteralPath $hp -PathType Leaf -ErrorAction SilentlyContinue)) { continue }
        try {
            $ht = [IO.File]::ReadAllText($hp)
            if ($ht -match '<agent-kit>') { $hookIssues += "$hk hook has unresolved <agent-kit> placeholder ($hp)" }
            elseif ($ht -notmatch 'guard\.mjs') { $hookIssues += "$hk config has no guard.mjs hook registered ($hp)" }
        } catch {}
    }
}
$hookSuffix = if ($hookIssues.Count) { " [hooks: WARN $($hookIssues -join '; ')]" } else { '' }
$diff = @($now.Keys | Where-Object {
    if ($now[$_] -eq 'not-found' -and (-not $old[$_] -or $old[$_] -eq 'not-found' -or $readFile -eq $baseFile)) { $false }
    else { $old[$_] -ne $now[$_] }
} | ForEach-Object { "$_ $(if ($old[$_]) { $old[$_] } else { '?' }) -> $($now[$_])" })
if ($diff.Count) { Write-Output ("TOOLS: CHANGED " + ($diff -join '; ') + " (tell the user and continue; re-check only when the user asks)" + $hookSuffix) }
else { Write-Output ("TOOLS: OK" + $hookSuffix) }
exit 0
