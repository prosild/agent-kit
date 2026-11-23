#!/usr/bin/env bash
# Linux half of update-tools.ps1: checks codex, claude and agy inside one WSL distro.
# Usage (update-tools.ps1 runs it as a login shell so the user's PATH is loaded):
#   wsl.exe -d Ubuntu -e bash -l /mnt/c/.../update-tools.sh [preview|apply]
# preview (default) prints path, version and the update command; apply runs "<tool> update" once per tool.
# Prints one line per tool for the caller:  ROW<TAB>tool<TAB>before<TAB>after<TAB>status<TAB>detail
# Status: READY (preview), UPDATED, CURRENT, SKIP, FAIL. Exit code 1 if any FAIL.
# Never installs a missing tool, never touches Windows paths (/mnt/..., *.exe) and never calls npm.
mode=${1:-preview}
case $mode in
  preview|apply) ;;
  *) echo "usage: update-tools.sh [preview|apply]" >&2; exit 2 ;;
esac
fails=0
row() { printf 'ROW\t%s\t%s\t%s\t%s\t%s\n' "$1" "${2:--}" "${3:--}" "$4" "$5"; }
fail() { row "$@"; fails=$((fails + 1)); }
# a version only counts when --version itself exits 0; keeps a prerelease/build suffix (1.2.3-beta.1)
ver() { local out; out=$("$1" --version 2>/dev/null) || return 1; printf '%s\n' "$out" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]+)?' | head -n 1; }
is_windows() { case $1 in /mnt/*|*.exe|*.cmd|*.bat) return 0 ;; esac; return 1; }

for tool in codex claude agy; do
  path=$(command -v "$tool" 2>/dev/null) || path=
  if [ -z "$path" ]; then row "$tool" - - SKIP "not installed"; continue; fi
  case $path in
    /*) ;;
    *) fail "$tool" - - FAIL "not an executable file (alias or function?): $path"; continue ;;
  esac
  real=$(readlink -f -- "$path" 2>/dev/null) || real=$path
  if is_windows "$path" || is_windows "$real"; then
    row "$tool" - - SKIP "Windows binary seen from WSL, not updated here: $path"; continue
  fi
  case $real in
    */node_modules/*) fail "$tool" - - FAIL "package-manager install ($real), standalone install required"; continue ;;
  esac
  before=$(ver "$path")
  if [ -z "$before" ]; then fail "$tool" - - FAIL "version check failed: $path"; continue; fi
  if [ "$mode" = preview ]; then
    row "$tool" "$before" - READY "would run: $path update (resolves to $real)"; continue
  fi
  echo "== $tool ($path) update" >&2
  "$path" update >&2
  rc=$?
  after=$(ver "$path")
  if [ "$rc" -ne 0 ]; then fail "$tool" "$before" "$after" FAIL "update exit $rc"
  elif [ -z "$after" ]; then fail "$tool" "$before" - FAIL "version check after update failed"
  elif [ "$after" = "$before" ]; then row "$tool" "$before" "$after" CURRENT "update exit 0"
  else row "$tool" "$before" "$after" UPDATED "update exit 0"
  fi
done
[ "$fails" -eq 0 ]
