// PreToolUse guard for Claude Code, Codex and Antigravity. A guard rail against mistakes, NOT a sandbox and not an
// enforcement boundary: it matches command text, so a determined or unusual command shape can still get past it
// (see RUNBOOK 9). It blocks secret-file access, pushes the repository's submission policy forbids (local Git config
// agentkit.* written by init.ps1, read the same way as hooks/pre-push; main/master when unset) and skipping that hook,
// permission-bypass flags, and edits to the hook files themselves.
// Claude/Codex send JSON on stdin with tool_name/tool_input/cwd. A PreToolUse event is blocked with the shared
// hookSpecificOutput.permissionDecision="deny" JSON on stdout and exit 0: Codex runs hooks through the session shell
// (powershell -Command), which turns exit 2 into 1, and Codex treats 1 as a failed hook that does not block.
// Other callers (no hook_event_name) still get stderr + exit 2.
// Claude tools: Read/Edit/Write/NotebookEdit/Grep/Glob/Bash/PowerShell. Codex tools: Bash (shell, incl. exec_command)
// and apply_patch (tool_input.command = patch text).
// Antigravity (agy) sends camelCase { toolCall: { name, args }, cwd, lastUserInput, ... }
// and reads stdout: {"decision":"deny","reason":...} blocks, {"decision":"allow"} auto-approves, empty stdout = no opinion
// (normal permission rules). `{}` without a decision is treated as deny, and a non-zero exit as a failed hook that also
// blocks, so this script prints nothing to pass. Tools: read_file{Path}, write_file{Path,Content},
// edit_file{Path,Target,Replacement}, run_command{CommandLine}.
// Registered in ~/.claude/settings.json, ~/.codex/hooks.json and ~/.gemini/config/hooks.json.
// Fails open on unparsable input.
import { execSync, execFileSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SECRET = /(^|[\\/])(\.env(\.[\w-]+)*|\.credentials\.json|credentials\.json|oauth_creds\.json|mcp_oauth_tokens\.json|mcp_config\.json|\.npmrc|_?\.netrc|_netrc|\.git-credentials|\.claude\.json|id_(rsa|ed25519|ecdsa|dsa)|[^\\/]+\.(pem|p12|pfx|key|jks|keystore))$/i;
// Test credentials / browser session files. Viewing or copying their contents is blocked (Read/Edit, viewer/copy commands);
// creating them (Write) and passing them to test tools (curl -b, node, python, playwright) is allowed.
// "test" must start a word (latest-accounts.json and contest_account.json are ordinary files).
const TEST_CRED = /(^|[\\/])([^\\/]*(?<![a-z0-9])test[-_]?accounts?[^\\/]*\.json|[^\\/]*(?:cookies?\.txt|\.cookies?)|[^\\/]*storage[-_]?state[^\\/]*\.json)$/i;
// Commands whose main job is to show file contents (subset of READERS without copy/transfer/interpreters).
const VIEWERS = /^(cat|type|head|tail|less|more|gc|get-content|select-string|sls|base64|grep|rg|findstr|awk|sed|diff|certutil|xxd|od|strings|sort|nl|tac)$/i;
// Secrets recognised by folder + name (a plain auth.json / credentials / hosts.yml elsewhere is allowed).
const SECRET_DIR = /(^|[\\/])(\.codex[\\/]auth\.json|\.aws[\\/]credentials|\.docker[\\/]config\.json|\.kube[\\/]config|(gh|GitHub CLI)[\\/]hosts\.yml)$/i;
// Not secrets: env templates and source/doc files that merely have .env in the name (.env.example, .env.d.ts, .env.md).
const SECRET_OK = /\.env(\.[\w-]+)*\.(example|sample|template|defaults|dist|schema|md|ts|js|mjs|cjs)$/i;
// Codex equivalents (codex --help): -s/--sandbox danger-full-access, -a/--ask-for-approval never, the same keys given as
// -c config overrides, and --dangerously-bypass-hook-trust. --yolo is not in --help but is blocked in case it is a hidden alias.
const BYPASS = /--dangerously-skip-permissions|--allow-dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox|--dangerously-bypass-hook-trust|--permission-mode[ =]+["']?bypassPermissions|defaultMode["'\s:=]+bypassPermissions|--no-parent\b|--yolo\b|(^|\s)(-s|--sandbox)[ =]+["']?danger-full-access|(^|\s)(-a|--ask-for-approval)[ =]+["']?never\b|approval_policy\s*=\s*["']?never|sandbox_mode\s*=\s*["']?danger-full-access/i;
// First word of a command segment that reads or copies file contents.
const READERS = /^(cat|type|head|tail|less|more|gc|get-content|select-string|sls|copy|copy-item|cp|scp|mv|move|move-item|ren|rename-item|curl|base64|grep|rg|findstr|awk|sed|diff|certutil|xxd|od|strings|sort|nl|tac|node|python|python3|py|powershell|pwsh)$/i;
// Commands that delete, move or overwrite the files named in their arguments (checked against the protected files below).
const MUTATORS = /^(rm|del|erase|rd|rmdir|remove-item|ri|mv|move|move-item|mi|ren|rename|rename-item|rni|set-content|add-content|clear-content|out-file|tee|tee-object|truncate|cp|copy|copy-item|cpi)$/i;

let AGY = false;   // true when the caller is Antigravity (decision JSON on stdout instead of exit 2)
let PRE = false;   // true for a Claude/Codex PreToolUse event (permissionDecision JSON on stdout, exit 0)
function block(msg) {
  const text = `[guard] 차단: ${msg}. 우회하지 말고 상위에 보고하세요.`;
  if (AGY) { process.stdout.write(JSON.stringify({ decision: 'deny', reason: text })); process.exit(0); }
  if (PRE) {
    writeSync(1, JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: text } }) + String.fromCharCode(10));
    process.exit(0);
  }
  process.stderr.write(text + '\n'); process.exit(2);
}
function autoAllow(reason) { process.stdout.write(JSON.stringify({ decision: 'allow', reason })); process.exit(0); }

// Absolute, '..'-free, forward-slash, lower-case form of a path seen from the session folder (so that
// handoff/<stem>/../../x cannot pass as the stem's own folder).
function absPath(base, p) { return resolve(base || process.cwd(), String(p || '')).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); }
function realAbsPath(base, p) {
  const full = resolve(base || process.cwd(), String(p || ''));
  let cur = full;
  const tail = [];
  for (let i = 0; i < 32; i++) {
    try {
      if (existsSync(cur)) {
        const rp = (realpathSync.native ? realpathSync.native(cur) : realpathSync(cur));
        return resolve(rp, ...tail).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      }
    } catch { break; }
    const parent = dirname(cur);
    if (!parent || parent === cur) break;
    tail.unshift(cur.slice(parent.length).replace(/^[\\/]+/, ''));
    cur = parent;
  }
  return full.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
function norm(p) { return String(p).trim().replace(/^["'`]+|["'`,]+$/g, '').replace(/::\$DATA$/i, '').replace(/[. ]+$/, ''); }
function reEsc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ---- Antigravity sub-session scope -------------------------------------------------------------------------------
// Scope applies to an explicit task-file instruction, not a report-path mention in ordinary work.
// Launches and follow-ups use "Read <task path> and follow it." (also inside /plan and hc wrappers).
// - review session: only the read tools in REVIEW_READ and its own files (<stem>-report.md, <stem>/...) may be used;
//   everything else (shell, MCP, browser, unknown tools) is denied, so read-only is an allow-list.
// - research session: keeps the normal approval rules, but may not write other files under handoff/ (handoff files,
//   reports and verify evidence of other runs).
// - the session's own files are auto-allowed only when the input STARTS with "Read …", not when the name is merely
//   quoted somewhere. Auto-allow is honoured by agy in auto mode; a plan-mode session still asks (RUNBOOK 9).
// If a person types something else into the session, lastUserInput no longer names the file and the scope ends. Review
// sessions use --mode plan and session settings so an out-of-scope turn still asks for approval.
function subSession(ev) {
  const input = String(ev.lastUserInput || '');
  const m = /handoff[\\/]((?:sub|agy)-[a-z0-9_.-]+-(?:review|research|flash)-\d+)\.md(?![\w.-])/i.exec(input);
  if (!m) return null;
  const stem = m[1].toLowerCase();
  const anchored = /^\s*(?:\/[\w-]+\s+)?(?:<hc\b[^>]*>\s*)?["'`]*Read\s/i.test(input);
  const prefix = input.slice(0, m.index);
  const suffix = input.slice(m.index + m[0].length);
  const directive = anchored && /^\s*(?:\/[\w-]+\s+)?(?:<hc\b[^>]*>\s*)?["'`]*Read\s+["'`]?[^\r\n"'`]*$/i.test(prefix)
    && /^["'`]?\s+and follow it\./i.test(suffix);
  const koreanDirective = /^\s*(?:[A-Za-z]:[\\/]|\/)?[^\s"'`]*$/.test(prefix) && /^를 다시 읽고 따라/.test(suffix);
  if (!directive && !koreanDirective) return null;
  return { stem, review: /-review-\d+/.test(stem), anchored };
}
// Read-only tools a review session may use. The verified review configuration offers read_file as its only read
// tool (no list/search tool; MCP calls arrive as call_mcp_tool and are denied). view_file is the older name. If a new read
// tool is denied, check its name in %TEMP%/agent-guard/last-agy-<tool>.json and add it here.
const REVIEW_READ = /^(read_file|view_file)$/;
// Returns the auto-allow reason for the session's own files (applied only after the secret checks below), blocks what the
// session may not do, and returns null otherwise.
function subSessionScope(ev, name, a) {
  const s = subSession(ev);
  if (!s) return null;
  const base = ev.cwd || (ev.workspacePaths || [])[0] || process.cwd();
  if (/^(write_file|edit_file)$/.test(name)) {
    const p = absPath(base, a.Path);
    const own = new RegExp(`/handoff/${reEsc(s.stem)}-report\\.md$`).test(p) || p.includes(`/handoff/${s.stem}/`);
    if (own) return s.anchored ? `agent-kit: ${s.stem}의 자기 보고 파일` : null;
    if (s.review) block(`검토 세션(${s.stem})은 자기 보고 파일(handoff/${s.stem}-report.md, handoff/${s.stem}/) 외에는 쓰지 않는다 (${a.Path})`);
    if (/\/handoff\//.test(p)) block(`하위 세션(${s.stem})은 다른 인계·보고·검증 파일을 고치지 않는다 (${a.Path})`);
  }
  else if (s.review && !REVIEW_READ.test(name)) block(`검토 세션(${s.stem})은 읽기 도구와 자기 보고 파일 쓰기만 쓴다 (${name}). 필요하면 보고에 적는다`);
  return null;
}

// ---- secrets -----------------------------------------------------------------------------------------------------
function isSecretPath(p) {
  if (typeof p !== 'string' || !p) return false;
  const n = norm(p);
  return (SECRET.test(n) || SECRET_DIR.test(n)) && !SECRET_OK.test(n);
}
function isTestCred(p) { return typeof p === 'string' && !!p && TEST_CRED.test(norm(p)); }
function looksSecretGlob(g) { return typeof g === 'string' && /\.env(?![.\w]*(example|sample|template|defaults|dist|schema|md|ts|js|mjs|cjs))(?!\.d\.ts)(?!\w)|credentials(?![^\\/]*\.(?:[cm]?js|jsx|tsx?|py)$)|oauth_creds|mcp_oauth_tokens|mcp_config|\.pem(?![.\w])|\.key(?![.\w])|\.jks(?![.\w])|\.keystore(?![.\w])|id_rsa|id_ed25519|netrc|npmrc|(?<![a-z0-9])test[-_]?accounts?[^\\/]*\.json|cookies?\.txt|\.cookies?(?![.\w])|storage[-_]?state[^\\/]*\.json/i.test(g); }

// ---- protected files ---------------------------------------------------------------------------------------------
// Files an agent must not change, because changing them switches the guard rails off:
//  - a repository's .git/hooks/* and .git/config (the pre-push hook and core.hooksPath)
//  - agent-kit's own files when the session is working on another project (cwd outside agent-kit)
//  - global/project agent permission, rule and hook configuration files (outside agent-kit maintenance)
//  - verification approval/acceptance/evidence files under handoff/<ID>/
// Reading is never restricted.
const KIT = absPath(dirname(fileURLToPath(import.meta.url)), '..');
const KIT_REAL = realAbsPath(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = homedir();
const REGISTRATION = ['.claude/settings.json', '.codex/hooks.json', '.gemini/config/hooks.json'].map((f) => absPath(HOME, f));
const GLOBAL_AGENT_FILES = [
  '.claude/settings.json', '.claude/settings.local.json',
  '.codex/hooks.json', '.codex/config.toml',
  '.gemini/config/hooks.json', '.gemini/antigravity-cli/settings.json',
].map((f) => absPath(HOME, f));
const GLOBAL_AGENT_DIRS = ['.codex/rules', '.claude/skills', '.agents/skills', '.gemini/config/skills'].map((d) => absPath(HOME, d));
function inDir(ap, dir) { return ap === dir || ap.startsWith(dir + '/'); }
function inKit(ap) { return inDir(ap, KIT) || inDir(ap, KIT_REAL); }
// Reason text if `p` (seen from `cwd`) is protected, else null. keepsGuard: the new content still registers guard.mjs.
function protectedWrite(cwd, p, keepsGuard) {
  const np = norm(p);
  const ap = absPath(cwd, np);
  const rp = realAbsPath(cwd, np);
  const inKitCwd = inKit(absPath(cwd, '.')) || inKit(realAbsPath(cwd, '.'));
  const caller = callerInfo();
  const isWorkerOrSub = !!(caller.isWorker || caller.subStem || /[\\/]\.worktrees([\\/]|$)/i.test(cwd));
  if (/(^|\/)\.git\/(hooks(\/|$)|config$)/.test(ap) || /(^|\/)\.git\/(hooks(\/|$)|config$)/.test(rp)) return `Git 훅·설정 파일 변경 (${p}). pre-push 훅은 init.ps1이 설치한다`;
  if (/(^|\/)handoff\/[^/]+\/(approved\.json|accepted\.json|approvals(\/|$)|verify(\/|$))/.test(ap) || /(^|\/)handoff\/[^/]+\/(approved\.json|accepted\.json|approvals(\/|$)|verify(\/|$))/.test(rp)) return `검증·승인·수락 증거 파일 직접 변경 (${p}). verify.ps1로만 갱신한다`;
  if ((inKit(ap) || inKit(rp)) && !inKitCwd) return `다른 프로젝트 세션에서 agent-kit 파일 변경 (${p}). 키트 수정은 agent-kit 폴더 세션에서만 한다`;
  if ((inKit(ap) || inKit(rp)) && /\/local-defaults\.json$/.test(ap) && isWorkerOrSub) return `작업자·하위 세션에서 local-defaults.json 변경 (${p}). 로컬 기본 모델은 사용자가 관리한다`;
  const isGlobalCfg = GLOBAL_AGENT_FILES.includes(ap) || GLOBAL_AGENT_FILES.includes(rp) || GLOBAL_AGENT_DIRS.some((d) => inDir(ap, d) || inDir(rp, d));
  const isProjectCfg = /(^|\/)(\.claude\/settings[^/]*\.json|\.codex(\/|$)|\.agents\/hooks\.json)$/.test(ap);
  if ((isGlobalCfg || isProjectCfg) && (!inKitCwd || isWorkerOrSub)) return `에이전트 권한·훅 설정 파일 변경 (${p}). 권한 설정은 사용자가 직접 관리한다`;
  if ((REGISTRATION.includes(ap) || REGISTRATION.includes(rp)) && !keepsGuard) return `훅 등록 파일에서 guard를 빼거나 미치환 경로(<agent-kit>)로 바꾸는 변경 (${p})`;
  return null;
}

// ---- shell parsing -----------------------------------------------------------------------------------------------
// Coarse split: ; && || | and newlines. Quotes are not parsed; good enough for a guard rail.
function coarse(cmd) { return cmd.split(/&&|\|\||[;|\n]/).map((s) => s.trim()).filter(Boolean); }
// Fine split: block and sub-expression openers also start a segment, so `if (...) { Get-Content .env }`,
// `try { git push --no-verify }`, `echo $(cat .env)`, `Write-Output (Get-Content .env)` and backtick substitution are
// checked by their inner command. `${VAR}` / `@{...}` are not split. Trailing `}` and `)` are dropped.
function segments(cmd) { return cmd.split(/&&|\|\||[;|\n`]|(?<![$@])\{|\(/).map((s) => s.replace(/[\s})]+$/, '').trim()).filter(Boolean); }
// Check agent invocations at unquoted command boundaries. A prompt can contain shell punctuation and agent names.
function agentSegments(cmd) {
  const result = [];
  let quote = '', here = '', start = 0;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (here) {
      if (c === here && /[\r\n]/.test(cmd[i - 1]) && cmd[i + 1] === '@') { here = ''; i++; }
      continue;
    }
    if (quote) {
      if (c === quote) quote = '';
      else if (c === '\\' && cmd[i + 1] === quote && quote === '"') i++;
      continue;
    }
    if (c === '@' && /["']/.test(cmd[i + 1]) && /[\r\n]/.test(cmd[i + 2])) here = cmd[++i];
    else if (c === '"' || c === "'") quote = c;
    else if (/[;|\r\n{}()]/.test(c) || (c === '&' && cmd[i + 1] === '&')) {
      result.push(cmd.slice(start, i));
      if (c === '&') i++;
      start = i + 1;
    }
  }
  result.push(cmd.slice(start));
  return result;
}
// Words of a segment with leading wrappers removed, so that w[0] is the real command: control keywords
// (`then cat f`, `if git push …`, `} else …`), the PowerShell call operator `&`, assignments (`$x = cmd`, `FOO=1 cmd`),
// `cmd /c <command>` and `hc exec <command>`.
function words(seg, unwrapCmdScript = false) {
  const w = (seg.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []).filter(Boolean);
  for (let n = 0; n < 16; n++) {
    const a = w[0] || '';
    if (w.length > 1 && /^(&|\}|then|do|else|try|finally|if|while|until|elif|!|command|builtin|time|exec|env|sudo|nohup)$/i.test(a)) w.shift();
    else if (/^\$[\w:]+$/.test(a) && w[1] === '=') w.splice(0, 2);          // $x = cmd
    else if (/^\$[\w:]+=$/.test(a)) w.shift();                              // $x= cmd
    else if (/^\$[\w:]+=./.test(a)) w[0] = a.replace(/^\$[\w:]+=/, '');     // $x=cmd
    else if (w.length > 1 && /^[A-Za-z_]\w*=\S*$/.test(a)) w.shift();       // FOO=1 cmd
    else if (/^cmd$/i.test(verbOf(a)) && /^\/[ck]$/i.test(w[1] || '')) {
      w.splice(0, 2);
      const script = w[0]?.replace(/^(["'])(.*)\1$/, '$2');
      if (unwrapCmdScript && script !== w[0]) return words(script);
    }
    else if (/^hc$/i.test(verbOf(a)) && /^exec$/i.test(w[hcSubcommandIndex(w)] || '')) {
      w.splice(0, hcSubcommandIndex(w) + 1);
      w.splice(0, hcArgumentIndex(w, 0, /^--(on|cwd|env|timeout)$/i));
    }
    else break;
  }
  return w;
}
// Program name of a word: `"C:\x\agy.exe"` -> agy, `(Get-Content` -> Get-Content.
function verbOf(word) { return String(word || '').replace(/^[({]+/, '').replace(/^["'`]+|["'`]+$/g, '').replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|ps1)$/i, ''); }
// Parses `hc [global opts] run [hc-run opts] [--] <targetExe> [targetArgs...]` so provider/flag checks inspect the
// actual target binary and its option tokens, never words that merely appear inside the trailing prompt text.
function hcRunInfo(w) {
  const rIdx = hcSubcommandIndex(w);
  if (norm(w[rIdx] || '').toLowerCase() !== 'run') return null;
  let cwd = null, name = null, i = rIdx + 1;
  while (i < w.length) {
    const tok = norm(w[i]);
    if (tok === '--') { i++; break; }
    if (/^--(cwd|name|label|parent|template|on|timeout|env)$/i.test(tok)) {
      const val = norm(w[i + 1] || '');
      if (/^--cwd$/i.test(tok)) cwd = val;
      else if (/^--name$/i.test(tok)) name = val;
      i += 2; continue;
    }
    if (/^--(cwd|name|label|parent|template|on|timeout|env)=/i.test(tok)) {
      const eq = tok.indexOf('='), k = tok.slice(2, eq).toLowerCase(), v = norm(tok.slice(eq + 1));
      if (k === 'cwd') cwd = v;
      else if (k === 'name') name = v;
      i++; continue;
    }
    if (tok.startsWith('-')) { i++; continue; }
    break;
  }
  const targetExe = w[i] || '';
  const targetVerb = verbOf(targetExe).toLowerCase();
  const rest = w.slice(i + 1);
  const optTokens = rest.filter((t) => norm(t).startsWith('-'));
  return { cwd, name, targetExe, targetVerb, rest, optTokens };
}
// Commands that start an agent or another process; a bypass flag only counts when one of these runs it.
const LAUNCHERS = /^(claude|codex|agy|gemini|npx|npm|bunx|pnpm|yarn|node|bash|sh|env|sudo|start|start-process|cmd|powershell|pwsh)$/i;
const AGY_PROGRAM = /^(agy|antigravity)$/i;
const WRAPPER = /^(bash|sh|env|sudo|start|start-process|cmd|powershell|pwsh)$/i;

const HC_FALLBACK = process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA || join(HOME, 'AppData', 'Local'), 'Programs', 'herdr-core', 'hc.exe') : '';

// Inspect a Herdr terminal without supplying the hook caller's terminal ID.
function hcGetTerminal(target) {
  if (!target) return null;
  const env = { ...process.env };
  delete env.HC_TERMINAL_ID;
  const opts = { env, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true };
  try {
    let result;
    try { result = execFileSync('hc', ['get', '--json', '--', target], opts); }
    catch (err) {
      if (err?.code === 'ENOENT' && HC_FALLBACK && existsSync(HC_FALLBACK)) {
        result = execFileSync(HC_FALLBACK, ['get', '--json', '--', target], opts);
      } else { throw err; }
    }
    const t = JSON.parse(result);
    return t && typeof t === 'object' ? t : null;
  } catch { /* Unavailable or invalid terminal facts cannot authorize input. */ }
  return null;
}

function hcTargetInfo(target) {
  const t = hcGetTerminal(target);
  if (!t) return { provider: 'unknown', parent: '' };
  const parent = typeof t.parent === 'string' ? t.parent : '';
  const launch = Array.isArray(t.argv) ? t.argv[0] : null;
  const programs = [launch, t.foreground?.name, t.status?.app].map((name) => typeof name === 'string' ? verbOf(name) : '');
  if (programs.some((name) => AGY_PROGRAM.test(name))) return { provider: 'agy', parent };
  if (typeof t.address === 'string' && t.state === 'live' && (programs[1] || programs[2] || (programs[0] && !WRAPPER.test(programs[0])))) {
    return { provider: 'other', parent };
  }
  return { provider: 'unknown', parent };
}

let callerCache;
function callerInfo() {
  if (callerCache !== undefined) return callerCache;
  const id = String(process.env.HC_TERMINAL_ID || '').trim();
  const t = id ? hcGetTerminal(id) : null;
  const hcName = typeof t?.name === 'string' ? t.name : '';
  const roleEnv = String(process.env.AGENTKIT_ROLE || '').trim();
  const name = hcName || roleEnv;
  const sub = /^((?:sub|agy)-[a-z0-9_.-]+-(?:review|research|flash)-\d+)$/i.exec(hcName)
    || /^((?:sub|agy)-[a-z0-9_.-]+-(?:review|research|flash)-\d+)$/i.exec(roleEnv)
    || (/^sub:([a-z0-9_.-]+)$/i.exec(roleEnv));
  const isWorker = /^task-[a-z0-9_.-]+$/i.test(hcName) || /^(worker|task-[a-z0-9_.-]+)$/i.test(roleEnv);
  callerCache = { id, name, subStem: sub ? sub[1].toLowerCase() : null, isWorker };
  return callerCache;
}

function hcArgumentIndex(w, start, valueOption) {
  for (let i = start; i < w.length; i++) {
    const arg = norm(w[i]);
    if (arg === '--') return i + 1;
    if (valueOption.test(arg)) { i++; continue; }
    if (!arg.startsWith('-')) return i;
  }
  return w.length;
}

function hcSubcommandIndex(w) { return hcArgumentIndex(w, 1, /^$/); }

// Lightweight anti-burst & anti-infinite-loop guardrail for hc run / hc send / hc keys.
// Never blocks just because another AGY session is working; enforces a minimum gap between AGY launches and
// sliding-window caps to catch retry loops and accidental fan-out bursts.
function rateFilePath() {
  const env = process.env.AGENTKIT_RATE_FILE;
  if (env === 'off') return null;
  if (env) return env;
  const base = process.platform === 'win32'
    ? (process.env.LOCALAPPDATA || join(HOME, 'AppData', 'Local'))
    : join(HOME, '.cache');
  return join(base, 'agent-kit', 'hc-rate.json');
}
function readRateEvents(path, now) {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (Array.isArray(data?.events)) {
      return data.events.filter((e) => e && typeof e.ts === 'number' && e.ts >= now - 3600_000 && e.ts <= now + 60_000);
    }
  } catch {}
  return [];
}
function writeRateEvents(path, events) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ events }) + '\n');
    return true;
  } catch {
    return false;
  }
}
function enforceRateLimits(actions) {
  if (!actions.length) return;
  const primary = rateFilePath();
  if (!primary) return;
  const fallback = join(tmpdir(), 'agent-kit-hc-rate.json');
  const now = Number(process.env.AGENTKIT_NOW_MS) || Date.now();
  let activePath = primary;
  let events = readRateEvents(primary, now);
  if (!existsSync(primary) && !process.env.AGENTKIT_RATE_FILE && existsSync(fallback)) {
    const fbEvents = readRateEvents(fallback, now);
    if (fbEvents.length) { activePath = fallback; events = fbEvents; }
  }
  const within = (ms, pred) => events.filter((e) => e.ts >= now - ms && pred(e));
  for (const a of actions) {
    if (a.kind === 'run') {
      if (a.agy) {
        const agyRuns = within(3600_000, (e) => e.kind === 'run' && e.agy);
        const last = agyRuns.reduce((m, e) => (!m || e.ts > m.ts ? e : m), null);
        if (last && now - last.ts < 30_000) {
          const sec = Math.max(0, Math.floor((now - last.ts) / 1000));
          block(`AGY 연속 실행 간격 제한(최소 30초, 직전 실행 후 ${sec}초 경과). 잠시 기다렸다가 실행하세요`);
        }
        if (within(600_000, (e) => e.kind === 'run' && e.agy).length >= 6) {
          block('AGY 실행 빈도 상한(10분 내 6회) 초과 — 무한 루프·과다 호출 의심. 상태를 확인하고 사용자에게 보고하세요');
        }
        if (agyRuns.length >= 20) {
          block('AGY 실행 빈도 상한(60분 내 20회) 초과 — 과다 호출 의심. 사용자에게 확인하세요');
        }
      }
      if (a.name && within(600_000, (e) => e.kind === 'run' && e.name === a.name).length >= 3) {
        block(`같은 이름(${a.name})의 hc run 반복(10분 내 3회 초과) — 재시도 무한 루프 의심. 원인을 확인하고 보고하세요`);
      }
      if (within(600_000, (e) => e.kind === 'run').length >= 12) {
        block('hc run 과다 호출(10분 내 12회 초과) — 무한 루프 의심. 상태를 확인하고 사용자에게 보고하세요');
      }
    } else if (a.kind === 'send' && a.target) {
      if (a.sig && within(600_000, (e) => e.kind === 'send' && e.target === a.target && e.sig === a.sig).length >= 2) {
        block(`같은 대상(${a.target})에 동일한 hc send 반복(10분 내 3회째) — 무한 루프 의심. 화면(hc read)을 확인하고 보고하세요`);
      }
      if (within(60_000, (e) => e.kind === 'send' && e.target === a.target).length >= 3) {
        block(`같은 대상(${a.target})에 hc send 단기 과다 호출(1분 내 3회 초과) — 무한 루프 의심. 화면(hc read)을 확인하고 보고하세요`);
      }
      if (within(600_000, (e) => e.kind === 'send' && e.target === a.target).length >= 8) {
        block(`같은 대상(${a.target})에 hc send 과다 호출(10분 내 8회 초과) — 무한 루프 의심. 화면(hc read)을 확인하고 보고하세요`);
      }
    } else if (a.kind === 'keys' && a.target) {
      if (within(120_000, (e) => e.kind === 'keys' && e.target === a.target).length >= 10) {
        block(`같은 대상(${a.target})에 hc keys 과다 호출(2분 내 10회 초과) — 승인 루프 의심. 화면(hc read)을 확인하고 보고하세요`);
      }
    }
    events.push({ ...a, ts: now });
  }
  if (!writeRateEvents(activePath, events) && !process.env.AGENTKIT_RATE_FILE && activePath !== fallback) {
    writeRateEvents(fallback, events);
  }
}
// Options of search commands that take a value (so the value is not mistaken for the search pattern).
const SEARCH_VALUE_OPT = /^(-path|-literalpath|-include|-exclude|-encoding|-context|-f|--file|--include|--exclude|--exclude-dir|-g|--glob|-t|--type|-A|-B|-C|-m|--max-count)$/i;
// For search commands drop the search pattern (text, not a file) before looking for file names in the arguments:
// the value of -e/--regexp/-Pattern, otherwise the first positional argument (findstr /c:"text" carries its own pattern).
function searchArgs(verb, w) {
  if (!/^(rg|grep|egrep|fgrep|findstr|select-string|sls)$/i.test(verb)) return w.slice(1).join(' ');
  const rest = w.slice(1);
  const k = rest.findIndex((x) => /^(-e|--regexp|-pattern)$/i.test(x));
  if (k >= 0) rest.splice(k, 2);
  else if (!rest.some((x) => /^\/c:/i.test(x))) {
    let j = -1;
    for (let i = 0; i < rest.length; i++) {
      if (SEARCH_VALUE_OPT.test(rest[i])) { i++; continue; }
      if (!rest[i].startsWith('-') && !rest[i].startsWith('/')) { j = i; break; }
    }
    if (j >= 0) rest.splice(j, 1);
  }
  return rest.join(' ');
}

// Shell command text of a tool call, or null if the call is not a shell call. Besides Claude's Bash/PowerShell and
// Codex's documented Bash, it accepts other shell tool names, a `cmd` field and an argv array (["powershell","-Command","..."]),
// so an unexpected input shape is still checked instead of silently allowed.
const FILE_TOOLS = ['Read', 'Edit', 'Write', 'NotebookEdit', 'Grep', 'Glob', 'apply_patch'];
function shellCommand(tool, inp) {
  const shellName = /^(Bash|PowerShell|shell|local_shell|exec_command|unified_exec)$/i.test(tool);
  const c = inp.command !== undefined ? inp.command : inp.cmd;
  if (!shellName && (FILE_TOOLS.includes(tool) || c === undefined)) return null;
  if (Array.isArray(c)) {
    const a = c.map(String);
    // Only a shell's own "run this string" flag marks where the real command starts; any other argv (git -C, codex -c ...)
    // is kept whole so its verb and options are still checked.
    const exe = (a[0] || '').replace(/^.*[\\/]/, '').replace(/\.(exe|cmd)$/i, '').toLowerCase();
    let k = -1;
    if (/^(bash|sh|zsh|dash|ksh)$/.test(exe)) k = a.findIndex((x, i) => i > 0 && /^-l?c$/.test(x));
    else if (/^(powershell|pwsh)$/.test(exe)) k = a.findIndex((x, i) => i > 0 && /^-(c|command)$/i.test(x));
    else if (exe === 'cmd') k = a.findIndex((x, i) => i > 0 && /^\/[ck]$/i.test(x));
    return k >= 0 ? a.slice(k + 1).join(' ') : a.join(' ');
  }
  return typeof c === 'string' ? c : '';
}
// Shape of the last input per tool (names and value types only, never values) for checking what a tool really sends.
function recordShape(ev) {
  if (process.env.AGENT_GUARD_TEST) return;   // regression tests must not overwrite the shapes real sessions left
  try {
    const dir = join(tmpdir(), 'agent-guard');
    mkdirSync(dir, { recursive: true });
    const inp = ev.tool_input || (ev.toolCall && ev.toolCall.args) || {};
    const name = ev.tool_name || (ev.toolCall ? 'agy-' + ev.toolCall.name : 'none');
    const types = Object.fromEntries(Object.keys(inp).map((k) => [k, Array.isArray(inp[k]) ? 'array' : typeof inp[k]]));
    const safe = String(name).replace(/[^\w.-]/g, '_').slice(0, 40);
    writeFileSync(join(dir, `last-${safe}.json`), JSON.stringify({ time: new Date().toISOString(), hook_event_name: ev.hook_event_name || ev.hookEventName, tool_name: name, keys: Object.keys(ev), tool_input: types }, null, 1));
  } catch {}
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
// Any unexpected error passes (exit 0, empty stdout): for Antigravity a crashed hook would block every tool call.
process.stdin.on('end', () => { try { main(); } catch { process.exit(0); } });
function main() {
  let ev;
  try { ev = JSON.parse(raw); } catch { process.exit(0); }
  if (!ev || typeof ev !== 'object') process.exit(0);
  recordShape(ev);
  PRE = !ev.toolCall && ev.hook_event_name === 'PreToolUse';
  let agyAuto = null;   // auto-allow reason for an Antigravity sub-session's own file, granted after the secret checks
  const agySub = ev.toolCall ? subSession(ev) : null;
  // Antigravity: apply the sub-session scope, then map its tools onto the Claude shapes checked below.
  if (ev.toolCall) {
    AGY = true;
    const n = String(ev.toolCall.name || ''), a = ev.toolCall.args || {};
    agyAuto = subSessionScope(ev, n, a);
    const map = { read_file: ['Read', { file_path: a.Path }], view_file: ['Read', { file_path: a.Path }],
                  write_file: ['Write', { file_path: a.Path, content: a.Content }],
                  edit_file: ['Edit', { file_path: a.Path, old_string: a.Target, new_string: a.Replacement }],
                  run_command: ['Bash', { command: a.CommandLine }] };
    const m = map[n];
    ev = { tool_name: m ? m[0] : 'agy:' + n, tool_input: m ? m[1] : {}, cwd: ev.cwd || (ev.workspacePaths || [])[0] };
  }
  const tool = ev.tool_name || '';
  const inp = ev.tool_input || {};
  const cwd = ev.cwd || process.cwd();
  const hasGuard = (s) => /guard\.mjs/.test(String(s || '')) && !/<agent-kit>/i.test(String(s || ''));

  // Codex file edits: the patch names its files in "*** Add File: / *** Update File: / *** Delete File: / *** Move to:" lines.
  // Codex documents Edit/Write as aliases of apply_patch, so a patch body without file_path is checked the same way.
  const patchText = String(inp.command || inp.patch || inp.input || '');
  const isPatch = tool === 'apply_patch' || (['Edit', 'Write'].includes(tool) && !inp.file_path && /^\*\*\* (Add File|Update File|Delete File|Move to):/m.test(patchText));
  if (isPatch) {
    const removesGuard = /^-.*guard\.mjs/m.test(patchText) && !/^\+.*guard\.mjs/m.test(patchText);
    for (const m of patchText.matchAll(/^\*\*\* (Add File|Update File|Delete File|Move to): *(.+?)\s*$/gm)) {
      const [, kind, p] = m;
      if (isSecretPath(p)) block(`비밀 파일 편집 (${p})`);
      if (isTestCred(p) && (kind === 'Update File' || kind === 'Move to')) block(`테스트 자격증명 파일 편집 (${p}). 새로 만들거나 테스트 도구 인자로만 쓴다`);
      const keeps = kind === 'Update File' ? !removesGuard : kind === 'Add File' ? /^\+.*guard\.mjs/m.test(patchText) : false;
      const why = protectedWrite(cwd, p, keeps);
      if (why) block(why);
    }
    process.exit(0);
  }
  if (['Read', 'Edit', 'Write', 'NotebookEdit'].includes(tool)) {
    const p = inp.file_path || inp.notebook_path;
    if (isSecretPath(p)) block(`비밀 파일 접근 (${p})`);
    if (tool !== 'Write' && isTestCred(p)) block(`테스트 자격증명 파일 열람 (${p}). 테스트 도구 인자로만 쓴다`);
    if (tool !== 'Read' && typeof p === 'string' && p) {
      const keeps = tool === 'Write' ? hasGuard(inp.content) : !(hasGuard(inp.old_string) && !hasGuard(inp.new_string));
      const why = protectedWrite(cwd, p, keeps);
      if (why) block(why);
    }
    if (agyAuto) autoAllow(agyAuto);
    process.exit(0);
  }
  if (tool === 'Grep' || tool === 'Glob') {
    if (isSecretPath(inp.path) || isTestCred(inp.path)) block(`비밀 파일 검색 (${inp.path})`);
    const pat = tool === 'Grep' ? inp.glob : inp.pattern;
    if (looksSecretGlob(pat)) block(`비밀 파일 패턴 검색 (${pat})`);
    process.exit(0);
  }

  const cmd = shellCommand(tool, inp);
  if (cmd !== null) {
    const branchCache = new Map(), policyCache = new Map();
    // Branch of the repo the command acts on: ev.cwd, or the folder given by `git -C <dir>`.
    const currentBranch = (dir) => {
      const where = resolve(cwd, dir || '.');
      if (branchCache.has(where)) return branchCache.get(where);
      let b = '';
      try { b = execSync('git branch --show-current', { cwd: where, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { b = ''; }
      branchCache.set(where, b);
      return b;
    };
    // Submission and orchestration policy of that repo: the local Git config init.ps1 writes and hooks/pre-push reads.
    // pr: agentkit.protectedBranches (main,master if empty); direct: that list only; local: every push;
    // not set or unknown (older setups, or not a repository): main,master. Repository config only (--local), never global.
    const policyOf = (dir) => {
      const where = resolve(cwd, dir || '.');
      if (policyCache.has(where)) return policyCache.get(where);
      let cfg = '';
      try { cfg = execFileSync('git', ['config', '--local', '--get-regexp', '^agentkit\\.'], { cwd: where, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch { cfg = ''; }
      const get = (k) => { const m = new RegExp(`^agentkit\\.${k} (.*)$`, 'mi').exec(cfg); return m ? m[1].trim() : ''; };
      const sub = get('submission').toLowerCase();
      let prot = get('protectedbranches').split(',').map((s) => s.trim().replace(/^refs\/heads\//, '')).filter(Boolean);
      if (!/^(pr|direct|local)$/.test(sub) || (sub === 'pr' && !prot.length)) prot = ['main', 'master'];
      const crossMode = get('crossagentmode').toLowerCase();
      const p = { sub: sub || '미설정', local: sub === 'local', prot, names: prot.map(reEsc).join('|'), crossMode };
      policyCache.set(where, p);
      return p;
    };
    // ---- whole-command checks (coarse segments): flags and options that may sit anywhere after the launcher ----
    for (const seg of coarse(cmd)) {
      const w = words(seg, true);
      const verb = verbOf(w[0]);
      const hcInfo = /^hc$/i.test(verb) ? hcRunInfo(w) : null;
      const hcRun = !!hcInfo;
      // 0) permission-bypass flags: only when the segment launches an agent or a process (not when the flag name is
      //    mere text in a commit message, hc send, a heredoc line or a search pattern).
      if (BYPASS.test(seg) && (LAUNCHERS.test(verb) || hcRun)) block('권한 우회 플래그');
      // hc: options that cut or move the parent link.
      if (hcRun && /(^|\s)--(parent|outlive-parent)\b/.test(seg)) block('hc run의 부모 추적을 바꾸는 옵션');
      // A worker (in .worktrees/<id> or a task-* Herdr terminal) must never spawn another worker (task-<id>).
      if (hcRun && /^task-[a-z0-9_.-]+$/i.test(hcInfo.name || '') && (/[\\/]\.worktrees([\\/]|$)/i.test(cwd) || callerInfo().isWorker)) {
        block('작업자 세션은 다른 작업자(task-*)를 실행하지 않는다');
      }
      // Codex via hc run requires --no-daemon on the codex command itself so it stays in the hc child tree.
      if (hcRun && hcInfo.targetVerb === 'codex' && !hcInfo.optTokens.some((t) => /^--no-daemon$/i.test(norm(t)))) {
        block('hc run으로 codex를 띄울 때는 --no-daemon이 필요하다(없으면 부모 추적이 끊긴다)');
      }
      // Review iteration hard cap: stem numbers are cumulative across gap review (1..2) and pre-completion review (3..4); > 4 is blocked.
      if (hcRun && hcInfo.name) {
        const revCap = /^((?:sub|agy)-[a-z0-9_.-]*-review-(\d+))$/i.exec(hcInfo.name);
        if (revCap && Number.parseInt(revCap[2], 10) > 4) block(`하위 검토 세션(${revCap[1]})의 누적 실행 번호가 상한(4: 빈틈 검토 2회 + 완료 전 검토 2회)을 넘었다. 상위 세션이나 사용자에게 보고한다`);
      }
      // Interpreter inline scripts (`python -c "open('.env')"`, `node -e "readFileSync('.env')"`) contain `(` so
      // fine `segments()` splits the filename out of the interpreter segment; check them on the coarse segment too.
      if (/^(node|python|python3|py|deno|bun)$/i.test(verb)) {
        const inlineArgs = w.slice(1).join(' ').replace(/--(env-file|cacert|cafile|capath|cert|key|public-key|private-key|ssl-key|ssl-cert|tls-key|tls-cert)(=|\s+)\S+/gi, ' ');
        for (const tok of inlineArgs.split(/[\s|;&<>()=,:{}'"]+/).filter(Boolean)) {
          if (isSecretPath(tok) && !(/\.(key|pem|p12|pfx|jks|keystore)$/i.test(norm(tok)) && !/[\\/]/.test(tok))) {
            block(`비밀 파일을 읽는 명령 (${norm(tok)})`);
          }
        }
      }
      // git config overrides given through the environment skip the pre-push hook just like -c core.hooksPath.
      if (/(^|[\s;$:{(])GIT_CONFIG_(COUNT|PARAMETERS|KEY_\d+|VALUE_\d+|GLOBAL|SYSTEM)\s*=/.test(seg)) block('GIT_CONFIG_* 환경 변수(pre-push 훅 우회)');
    }
    const rateActions = [];
    for (const seg of agentSegments(cmd)) {
      const w = words(seg, true);
      const verb = verbOf(w[0]).toLowerCase();
      const hcInfo = verb === 'hc' ? hcRunInfo(w) : null;
      const hcRun = !!hcInfo;
      const runsAgy = (hcRun && AGY_PROGRAM.test(hcInfo.targetVerb)) || AGY_PROGRAM.test(verb);
      if (runsAgy) {
        const agyArgs = hcRun ? hcInfo.rest : w.slice(1);
        const agyWorker = hcRun && /^task-[a-z0-9_.-]+$/i.test(hcInfo.name || '');
        const modeIdx = agyArgs.findIndex((o) => norm(o).toLowerCase() === '--mode');
        const modeEq = agyArgs.find((o) => /^--mode=/i.test(norm(o)));
        const modeValue = modeIdx >= 0 ? norm(agyArgs[modeIdx + 1] || '').toLowerCase()
          : modeEq ? norm(modeEq).slice(7).toLowerCase() : '';
        if (modeValue === 'auto' && !agyWorker) block('agy --mode auto는 작업자(task-<id>) 실행에만 쓴다');
        const sub = hcRun && hcInfo.name ? /^((?:sub|agy)-[a-z0-9_.-]*-(?:review|research)-\d+)$/i.exec(hcInfo.name) : null;
        if (sub) {
          const promptText = agyArgs.at(-1) || '';
          if (!new RegExp(`handoff[\\\\/]${reEsc(sub[1])}\\.md`, 'i').test(promptText)) {
            block(`하위 세션(${sub[1]})의 시작 문장에 handoff/${sub[1]}.md가 없다`);
          }
          if (modeValue !== 'plan') block(`하위 세션(${sub[1]})은 --mode plan으로 띄운다(모드를 주지 않으면 auto 모드로 돈다)`);
        }
        const isDirectAgyLaunch = !hcRun && agyArgs.some((o) => /^(?:-i|-p|--prompt(?:-interactive)?|--print)(?:=|$)/i.test(norm(o)));
        if (isDirectAgyLaunch) rateActions.push({ kind: 'run', agy: true, name: '' });
      }
      if (verb !== 'hc') continue;
      const hcIndex = hcSubcommandIndex(w);
      const hcSub = norm(w[hcIndex] || '').toLowerCase();
      const hcHelp = w.length === hcIndex + 2 && /^(--help|-h)$/.test(norm(w[hcIndex + 1]));
      if (hcRun && !hcHelp) {
        rateActions.push({ kind: 'run', agy: AGY_PROGRAM.test(hcInfo.targetVerb), name: (hcInfo.name || '').toLowerCase() });
      }
      if (/^(send|keys|interrupt)$/.test(hcSub) && !hcHelp) {
        const targetIndex = hcArgumentIndex(w, hcIndex + 1, /^--(if|timeout)$/i);
        const target = norm(w[targetIndex] || '');
        const caller = callerInfo();
        if (caller.isWorker) {
          const { parent } = hcTargetInfo(target);
          if (!parent || parent !== caller.id) {
            block(`작업자 세션(${caller.name})은 자기가 띄운 직계 자식 터미널 외에는 입력·제어하지 않는다 (hc ${hcSub})`);
          }
        }
        if (hcSub === 'send' && target) {
          const sig = w.slice(targetIndex + 1).map(norm).join(' ').replace(/\s+/g, ' ').trim().slice(0, 200);
          rateActions.push({ kind: 'send', target: target.toLowerCase(), sig });
        } else if (hcSub === 'keys' && target) {
          rateActions.push({ kind: 'keys', target: target.toLowerCase() });
        }
      }
    }
    for (const seg of segments(cmd)) {
      const w = words(seg, true);
      const verb = verbOf(w[0]).toLowerCase();
      // Sub-sessions (research/review across all tools) must not spawn/control other hc terminals or run verify/init.
      if (verb === 'hc') {
        const hcIndex = hcSubcommandIndex(w);
        const hcSub = norm(w[hcIndex] || '').toLowerCase();
        const subStem = agySub?.stem || (/^(run|send|keys|interrupt|kill|rm)$/.test(hcSub) ? callerInfo().subStem : null);
        if (subStem && /^(run|send|keys|interrupt|kill|rm)$/.test(hcSub)) block(`하위 세션(${subStem})은 다른 에이전트 세션을 실행하거나 제어하지 않는다 (hc ${hcSub})`);
        if (/^(kill|rm)$/.test(hcSub)) {
          const caller = callerInfo();
          if (caller.isWorker) {
            const targetIndex = hcArgumentIndex(w, hcIndex + 1, /^--(if|timeout)$/i);
            const { parent } = hcTargetInfo(norm(w[targetIndex] || ''));
            if (!parent || parent !== caller.id) block(`작업자 세션(${caller.name})은 자기가 띄운 직계 자식 터미널 외에는 종료·제거하지 않는다 (hc ${hcSub})`);
          }
        }
        if (/^(run|send|keys)$/.test(hcSub)) {
          const hcInfo = hcRunInfo(w);
          const curPol = policyOf(null);
          const targetPol = hcInfo?.cwd ? policyOf(hcInfo.cwd) : curPol;
          if (curPol.crossMode === 'manual' || targetPol.crossMode === 'manual') block('이 저장소는 수동 인계(agentkit.crossAgentMode=manual) 모드다: hc run/send/keys 대신 작업·검토 파일을 쓰고 사용자에게 실행을 요청한다');
        }
      }
      // Role boundaries for agent-kit verification/policy scripts (applies even when Codex global rules allow them).
      // Only match when powershell/pwsh/verify/init actually invokes verify.ps1 or init.ps1 (not search patterns split on `|`).
      const scriptTokens = w.map((tok) => norm(tok));
      const runsVerify = (/^(powershell|pwsh)$/i.test(verb) && scriptTokens.some((tok) => /(?:^|[\\/])verify\.ps1$/i.test(tok))) || /^verify$/i.test(verb) && /(?:^|[\s"'\\/])verify\.ps1(?:["'\s]|$)/i.test(seg);
      const runsInit = (/^(powershell|pwsh)$/i.test(verb) && scriptTokens.some((tok) => /(?:^|[\\/])init\.ps1$/i.test(tok))) || /^init$/i.test(verb) && /(?:^|[\s"'\\/])init\.ps1(?:["'\s]|$)/i.test(seg);
      if (runsVerify || runsInit) {
        const caller = callerInfo();
        const subStem = agySub?.stem || caller.subStem;
        if (subStem) block(`하위 세션(${subStem})은 ${runsVerify ? 'verify.ps1' : 'init.ps1'}을 실행하지 않는다`);
        const isWorker = /[\\/]\.worktrees([\\/]|$)/i.test(cwd) || caller.isWorker;
        if (isWorker && runsVerify && scriptTokens.some((tok) => /^-(Prepare|Prep|Pre|Pr|Accept|Accep|Acce|Acc|Ac|A)$/i.test(tok))) {
          block('작업자 세션은 verify.ps1 -Prepare / -Accept를 실행하지 않는다(설계자 전용)');
        }
        if (isWorker && runsInit && scriptTokens.some((tok) => /^-(Submission|Subm\w*|Sub|Su|S|ProtectedBranches|Prot\w*|P|CrossAgentMode|Cross\w*|C|MaxVerifyFailures|Max\w*|M|Base|Bas|Ba|B)$/i.test(tok))) {
          block('작업자 세션은 init.ps1로 저장소 제출·호출 정책을 변경하지 않는다');
        }
      }
      // git [global opts] <sub>: skip global options (-C <dir>, -c <k=v>, --git-dir <d>, --no-pager, ...) to find the real subcommand.
      let i = 1, gitDir = null, gitSub = '';
      if (verb === 'git') {
        while (i < w.length && norm(w[i]).startsWith('-')) {
          const opt = norm(w[i]);
          if (opt === '-C') gitDir = norm(w[i + 1] || '');
          else if (/^-C./.test(opt)) gitDir = norm(opt.slice(2));
          i += (/^(-C|-c|--git-dir|--work-tree|--namespace|--config-env)$/.test(opt) ? 2 : 1);
        }
        gitSub = norm(w[i] || '');
      }
      const hcFile = verb === 'hc' && w[1] === 'file';
      // Arguments to check for file names: for search commands the pattern is text, not a file, so it is left out.
      // Files handed to a runtime as a key/certificate/env option are used, not shown (node --env-file, curl --cacert).
      let args = searchArgs(verb, w);
      if (/^(node|python|python3|py|curl|npx|deno|bun)$/i.test(verb)) args = args.replace(/--(env-file|cacert|cafile|capath|cert|key|public-key|private-key|ssl-key|ssl-cert|tls-key|tls-cert)(=|\s+)\S+/gi, ' ');
      // 1) secret files read by a reader command (only the segment's own arguments are checked).
      //    A bare name like `x.key` with no path separator is allowed (too many false positives such as obj.key).
      //    For copy/move/rename commands with source and destination, the last positional argument is the destination, not read.
      if (READERS.test(verb) || hcFile || /^(show|diff|cat-file|grep|log)$/.test(gitSub)) {
        const isCopyMove = /^(cp|copy|copy-item|cpi|mv|move|move-item|mi|ren|rename|rename-item|rni)$/i.test(verb);
        const isViewer = VIEWERS.test(verb) || hcFile;
        let readToks = args.split(/[\s|;&<>()=,:{}'"]+/).filter(Boolean);
        if (isCopyMove) {
          const pos = readToks.filter((t) => !norm(t).startsWith('-'));
          if (pos.length >= 2) readToks = readToks.slice(0, readToks.lastIndexOf(pos[pos.length - 1]));
        }
        for (const tok of readToks) {
          if (isSecretPath(tok) && !(!isViewer && /\.(key|pem|p12|pfx|jks|keystore)$/i.test(norm(tok)) && !/[\\/]/.test(tok))) {
            block(`비밀 파일을 읽는 명령 (${norm(tok)})`);
          }
          if ((isViewer || isCopyMove) && isTestCred(tok)) {
            block(`테스트 자격증명 파일 열람·복사 (${norm(tok)}). 테스트 도구 인자로만 쓴다`);
          }
        }
        if (/\.env\*|\.env\?/.test(args)) block('비밀 파일 와일드카드 읽기');
      }
      // Input redirection reads the file whatever the command is: `done < .env`, `while read l; do …; done < .env`.
      for (const m of seg.matchAll(/<\s*([^\s<>|;&()]+)/g)) if (isSecretPath(m[1]) || isTestCred(m[1])) block(`비밀 파일을 읽는 명령 (${norm(m[1])})`);
      // 1b) protected files (guard rails themselves): delete/move/overwrite commands and output redirection.
      if (MUTATORS.test(verb) || (verb === 'sed' && /(^|\s)-i/.test(seg))) {
        const isCopy = /^(cp|copy|copy-item|cpi)$/i.test(verb);
        const pos = [];
        const destTargets = [];
        for (let idx = 1; idx < w.length; idx++) {
          const tok = w[idx];
          if (/^-(Destination|LiteralPath|Path|Target)$/i.test(norm(tok)) && w[idx + 1]) {
            if (/^-Destination$/i.test(norm(tok)) || !isCopy) destTargets.push(w[idx + 1]);
            idx++; continue;
          }
          if (!tok.startsWith('-')) pos.push(tok);
        }
        const checkList = isCopy ? [...destTargets, ...(pos.length >= 2 ? pos.slice(-1) : pos)] : [...destTargets, ...pos];
        for (const tok of checkList) {
          const why = protectedWrite(cwd, tok, false);
          if (why) block(why);
        }
      }
      for (const m of seg.matchAll(/(?:^|[^<>&])(?:\d+)?>>?\s*("[^"]+"|'[^']+'|[^\s;|&>]+)/g)) {
        const why = protectedWrite(cwd, m[1], false);
        if (why) block(why);
      }
      // 2) the agent-kit git pre-push hook must not be skipped or redirected (it blocks main pushes for every agent).
      //    Blocked: `git -c core.hooksPath=... <sub>`, writing core.hooksPath with `git config`, an alias that carries
      //    --no-verify, `git send-pack` (does not run hooks). Reading, unsetting, searching and commit messages that only
      //    mention them are allowed.
      if (verb === 'git' && /core\.hooksPath/i.test(w.slice(1, i).join(' '))) block('git -c core.hooksPath(pre-push 훅 우회)');
      if (gitSub === 'config' && /core\.hooksPath/i.test(seg) && !/^(get|list|unset)$/.test(w[i + 1] || '')
          && !/(^|\s)(--get|--get-all|--get-regexp|--list|-l|--unset|--unset-all)(\s|$)/.test(seg)
          && w.filter((x, idx) => idx > i && !x.startsWith('-')).length >= 2) block('git config core.hooksPath 변경(pre-push 훅 우회)');
      if (gitSub === 'config' && /alias\./i.test(seg) && /--no-veri|hooksPath|send-pack/i.test(seg)) block('git alias로 pre-push 훅 우회');
      if (gitSub === 'send-pack') block('git send-pack(pre-push 훅을 거치지 않는 push)');
      // --no-verify, quoted or abbreviated (git accepts any unambiguous prefix such as --no-verif)
      if (gitSub === 'push' && /(^|[\s"'])--no-veri\w*/i.test(seg)) block('git push --no-verify(pre-push 훅 우회)');
      // 3) git push: real subcommand only, policy and branch read in the -C folder when given
      if (gitSub === 'push') {
        const pol = policyOf(gitDir);
        if (pol.local) block('push(이 저장소의 제출 방식은 local: 모든 push 차단. 바꾸려면 사용자가 init.ps1 -GitSetup -Submission으로 정한다)');
        const rest = w.slice(i + 1).join(' ').replace(/\s#.*$/, '');   // a trailing shell comment is not a ref
        const what = `보호 브랜치(${pol.prot.join(',')}, 제출 방식 ${pol.sub})`;
        if (pol.names && new RegExp(`(^|[\\s:+"']|refs\\/heads\\/)(${pol.names})(["'\\s]|$)`).test(rest)) block(`${what}로 push`);
        const cur = currentBranch(gitDir);
        if (pol.names && pol.prot.includes(cur)) {
          const refs = [];
          for (let j = i + 1; j < w.length; j++) {
            if (/^(-o|--push-option|--repo|--receive-pack|--exec)$/.test(w[j])) { j++; continue; }
            if (!w[j].startsWith('-')) refs.push(w[j]);
          }
          const explicitOther = refs.length >= 2 && !new RegExp(`(^|[:/])(${pol.names}|HEAD|@)$`, 'i').test(refs[refs.length - 1].replace(/["']/g, ''));
          const tagsOnly = /(^|\s)--tags(\s|$)/.test(rest) && refs.length <= 1;
          if (!explicitOther && !tagsOnly) block(`${what}인 현재 브랜치(${cur})에서 push`);
        }
      }
    }
    enforceRateLimits(rateActions);
  }
  process.exit(0);
}
