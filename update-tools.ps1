# Updates the codex, claude and agy CLIs on Windows and in one WSL distro with each tool's own "update" command.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File <agent-kit>/update-tools.ps1 [-Apply] [-Distro Ubuntu] [-WindowsOnly]
#   default  preview: path, version and the command that -Apply would run. Nothing is changed.
#   -Apply   runs "<tool> update" once per installed tool, then re-reads the version.
#   -Distro  the one WSL distro to include (default Ubuntu; other distros are never visited). -WindowsOnly skips WSL.
# Missing tools are SKIP (never installed). A failing tool is FAIL and the rest still run; any FAIL gives exit code 1.
# Windows tools must be .exe installs. Codex must be the standalone install (a package-manager launcher alone is FAIL);
# when PATH does not have it, the installer's default %LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe is used.
# The WSL half is update-tools.sh. CLI only, not the desktop apps. Version compatibility checks are check-tools.ps1.
param([switch]$Apply, [ValidateNotNullOrEmpty()][string]$Distro = 'Ubuntu', [switch]$WindowsOnly)

# This script only knows Windows .exe installs and wsl.exe. Elsewhere it would report every tool as a broken install.
if ($env:OS -ne 'Windows_NT') {
    Write-Output 'update-tools.ps1 runs on Windows only (it updates the Windows installs and one WSL distro). On macOS or Linux run each tool''s own update command, for example "claude update".'
    exit 2
}

# The shortcut uses -NoProfile. Decode native CLI/WSL output as UTF-8 even
# when this console starts with the Korean legacy code page (949).
# These settings affect this process/console only, not Git or saved profiles.
$cliEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $cliEncoding
[Console]::OutputEncoding = $cliEncoding
$OutputEncoding = $cliEncoding

$ErrorActionPreference = 'Continue'
$rows = New-Object System.Collections.Generic.List[object]
function Add-Row($tool, $envName, $before, $after, $status, $detail) {
    $rows.Add([pscustomobject]@{ Tool = $tool; Env = $envName; Before = $(if ($before) { $before } else { '-' }); After = $(if ($after) { $after } else { '-' }); Status = $status; Detail = $detail })
}
function Get-Ver([string]$path) {
    try {
        $out = (& $path --version 2>$null | Out-String)
        if ($LASTEXITCODE -ne 0) { return '' }
        if ($out -match '\d+\.\d+\.\d+([-+][0-9A-Za-z.+-]+)?') { return $Matches[0] }
    } catch {}
    return ''
}

# ---- Windows ----
$fallback = @{}
if ($env:LOCALAPPDATA) {
    $fallback['codex'] = Join-Path $env:LOCALAPPDATA 'Programs\OpenAI\Codex\bin\codex.exe'
    $fallback['agy']   = Join-Path $env:LOCALAPPDATA 'agy\bin\agy.exe'
}
foreach ($t in 'codex', 'claude', 'agy') {
    $all = @(Get-Command $t -All -CommandType Application, ExternalScript -ErrorAction SilentlyContinue | ForEach-Object { $_.Path } | Where-Object { $_ })
    $exe = $all | Where-Object { $_ -like '*.exe' } | Select-Object -First 1
    $other = @($all | Where-Object { $_ -notlike '*.exe' })
    $note = ''
    if (-not $exe -and $fallback[$t] -and (Test-Path -LiteralPath $fallback[$t] -PathType Leaf -ErrorAction SilentlyContinue)) { $exe = $fallback[$t]; $note = '; not on this PATH, using installer default' }
    if ($other.Count) { $note += "; non-exe launcher also on PATH: $($other[0])" }
    if (-not $exe) {
        if ($other.Count) {
            # version for the record only; a .cmd launcher avoids the execution policy problem of .ps1
            $cmd = $other | Where-Object { $_ -like '*.cmd' } | Select-Object -First 1
            $v = if ($cmd) { Get-Ver $cmd } else { '' }
            Add-Row $t 'Windows' $v '' 'FAIL' "only a non-exe launcher found ($($other[0])); standalone install required, not updated"
        } else { Add-Row $t 'Windows' '' '' 'SKIP' 'not installed' }
        continue
    }
    $before = Get-Ver $exe
    if (-not $before) { Add-Row $t 'Windows' '' '' 'FAIL' "version check failed: $exe"; continue }
    if (-not $Apply) { Add-Row $t 'Windows' $before '' 'READY' "would run: $exe update$note"; continue }
    Write-Host "== $t ($exe) update"
    $code = 0
    try { & $exe update | Out-Host; $code = $LASTEXITCODE } catch { Write-Host $_; $code = -1 }
    $after = Get-Ver $exe
    if ($code -ne 0) { Add-Row $t 'Windows' $before $after 'FAIL' "update exit $code" }
    elseif (-not $after) { Add-Row $t 'Windows' $before '' 'FAIL' 'version check after update failed' }
    elseif ($after -eq $before) { Add-Row $t 'Windows' $before $after 'CURRENT' "update exit 0$note" }
    else { Add-Row $t 'Windows' $before $after 'UPDATED' "update exit 0$note" }
}

# ---- WSL (one distro) ----
if (-not $WindowsOnly) {
    $envName = "WSL:$Distro"
    $sh = Join-Path $PSScriptRoot 'update-tools.sh'
    if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { Add-Row '(all)' $envName '' '' 'FAIL' 'wsl.exe not found' }
    elseif (-not (Test-Path -LiteralPath $sh)) { Add-Row '(all)' $envName '' '' 'FAIL' "missing $sh" }
    else {
        # -e runs the program directly (no shell re-parsing of arguments); bash -l loads the login PATH (~/.profile).
        $lin = (& wsl.exe -d $Distro -e wslpath -a -u $sh 2>$null | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or -not $lin.StartsWith('/')) { Add-Row '(all)' $envName '' '' 'FAIL' "cannot run distro '$Distro' (wsl exit $LASTEXITCODE)" }
        else {
            $mode = if ($Apply) { 'apply' } else { 'preview' }
            $out = @(& wsl.exe -d $Distro -e bash -l $lin $mode)
            $code = $LASTEXITCODE
            $n = 0
            foreach ($l in $out) {
                if ($l -like "ROW`t*") { $p = $l.Split("`t"); Add-Row $p[1] $envName $p[2] $p[3] $p[4] $p[5]; $n++ }
                else { Write-Host $l }
            }
            $wslFail = @($rows | Where-Object { $_.Env -eq $envName -and $_.Status -eq 'FAIL' }).Count
            if ($n -eq 0 -or ($code -ne 0 -and $wslFail -eq 0)) { Add-Row '(all)' $envName '' '' 'FAIL' "update-tools.sh exit $code" }
        }
    }
}

$rows | Format-Table Tool, Env, Before, After, Status, Detail -AutoSize -Wrap | Out-String -Width 400 | Write-Output
$failed = @($rows | Where-Object { $_.Status -eq 'FAIL' }).Count
if ($failed) { Write-Output "RESULT: FAIL ($failed)"; exit 1 }
Write-Output ("RESULT: OK (" + $(if ($Apply) { 'applied' } else { 'preview only, nothing changed; add -Apply to update' }) + ")")
exit 0
