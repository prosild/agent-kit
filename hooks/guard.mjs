// PreToolUse guard for Claude Code, Codex and Antigravity. A guard rail against mistakes, NOT a sandbox and not an
// enforcement boundary: real isolation comes from repository branch protection, token scopes and native CLI sandboxes/profiles
// (see RUNBOOK 9). It blocks secret-file access, pushes forbidden by local Git config `agentkit.*` (same keys as hooks/pre-push),
// skipping that hook, permission/hook-bypass flags, cross-role boundary violations, and edits to hook/config/evidence files.
import { execSync, execFileSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SECRET = /(^|[\\/])(\.env(\.[\w-]+)*|\.credentials\.json|credentials\.json|oauth_creds\.json|mcp_oauth_tokens\.json|mcp_config\.json|application_default_credentials\.json|ConsoleHost_history\.txt|\.(bash|zsh)_history|\.pypirc|\.npmrc|_?\.netrc|_netrc|\.git-credentials|\.claude\.json|terraform\.tfstate(\.backup)?|id_(rsa|ed25519|ecdsa|dsa)|[^\\/]+\.(pem|p12|pfx|key|jks|keystore))$/i;
const TEST_CRED = /(^|[\\/])([^\\/]*(?<![a-z0-9])test[-_]?accounts?[^\\/]*\.json|[^\\/]*(?:cookies?\.txt|\.cookies?)|[^\\/]*storage[-_]?state[^\\/]*\.json)$/i;
const VIEWERS = /^(cat|type|head|tail|less|more|gc|get-content|select-string|sls|base64|grep|rg|findstr|awk|sed|diff|certutil|xxd|od|strings|sort|nl|tac)$/i;
const SECRET_DIR = /(^|[\\/])(\.codex[\\/]auth\.json|\.aws[\\/]credentials|\.docker[\\/]config\.json|\.kube[\\/]config|(gh|GitHub CLI)[\\/]hosts\.yml|\.ssh[\\/](?!known_hosts(?:\.old)?$|[^\\/]+\.pub$)[^\\/]+|\.cargo[\\/]credentials(?:\.toml)?|\.m2[\\/]settings\.xml)$/i;
// Non-secret env templates, source/doc files, and committed non-local `.env.test` / `.env.ci` defaults.
const SECRET_OK = /(\.env(\.[\w-]+)*\.(example|sample|template|defaults|dist|schema|md|ts|js|mjs|cjs)|(^|[\\/])\.env\.(test|ci))$/i;
// Permission & hook-bypass flags across Claude, Codex, and Antigravity (including Claude's --bare / --safe-mode / user-less --setting-sources).
const BYPASS = /--dangerously-skip-permissions|--allow-dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox|--dangerously-bypass-hook-trust|--permission-mode[ =]+["']?bypassPermissions|defaultMode["'\s:=]+bypassPermissions|--no-parent\b|--yolo\b|--bare\b|--safe-mode\b|--setting-sources(?:[ =]+)["']?(?![^"'\s]*\buser\b)[a-z,]+|(^|\s)(-s|--sandbox)[ =]+["']?danger-full-access|(^|\s)(-a|--ask-for-approval)[ =]+["']?never\b|approval_policy\s*=\s*["']?never|sandbox_mode\s*=\s*["']?danger-full-access/i;
const READERS = /^(cat|type|head|tail|less|more|gc|get-content|import-csv|convertfrom-stringdata|select-string|sls|copy|copy-item|cp|scp|mv|move|move-item|ren|rename-item|curl|base64|grep|rg|findstr|awk|sed|diff|certutil|xxd|od|strings|sort|nl|tac|node|python|python3|py|powershell|pwsh)$/i;
const MUTATORS = /^(rm|del|erase|rd|rmdir|remove-item|ri|mv|move|move-item|mi|ren|rename|rename-item|rni|new-item|ni|set-content|sc|add-content|ac|clear-content|clc|out-file|tee|tee-object|truncate|cp|copy|copy-item|cpi)$/i;

let AGY = false;
let PRE = false;
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
// Preserve '.' and '..' path segments while stripping quotes, NTFS ADS suffixes, and Windows trailing dots/spaces on filenames.
function norm(p) {
  const s = String(p).trim().replace(/^["'`]+|["'`,]+$/g, '').replace(/::\$DATA$/i, '');
  if (/^(?:.*[\\/])?\.{1,2}$/.test(s)) return s;
  return s.replace(/[. ]+$/, '');
}
function reEsc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function atomicWriteJson(path, obj) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj) + '\n');
    try { renameSync(tmp, path); }
    catch {
      writeFileSync(path, JSON.stringify(obj) + '\n');
      try { unlinkSync(tmp); } catch {}
    }
    return true;
  } catch {
    return false;
  }
}

// ---- Antigravity sub-session scope (persisted by conversationId across follow-up turns) ---------------------------
function agySessionCachePath() {
  if (process.env.AGENT_GUARD_TEST) return null;
  const base = process.platform === 'win32'
    ? (process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'))
    : join(homedir(), '.cache');
  return join(base, 'agent-kit', 'agy-subsessions.json');
}
function rememberAgySubSession(convId, info) {
  const p = agySessionCachePath();
  if (!p || !convId) return;
  try {
    let map = {};
    if (existsSync(p)) {
      try { map = JSON.parse(readFileSync(p, 'utf8')) || {}; } catch { map = {}; }
    }
    const cutoff = Date.now() - 86_400_000;
    for (const [k, v] of Object.entries(map)) {
      if (!v || typeof v.ts !== 'number' || v.ts < cutoff) delete map[k];
    }
    map[convId] = { stem: info.stem, review: info.review, ts: Date.now() };
    atomicWriteJson(p, map);
  } catch {}
}
function recallAgySubSession(convId) {
  const p = agySessionCachePath();
  if (!p || !convId || !existsSync(p)) return null;
  try {
    const map = JSON.parse(readFileSync(p, 'utf8')) || {};
    const hit = map[convId];
    if (hit && typeof hit.stem === 'string') return { stem: hit.stem, review: !!hit.review, anchored: false };
  } catch {}
  return null;
}

function subSession(ev) {
  const input = String(ev.lastUserInput || '');
  const m = /handoff[\\/]((?:sub|agy)-[a-z0-9_.-]+-(?:review|research|flash)-\d+)\.md(?![\w.-])/i.exec(input);
  if (m) {
    const stem = m[1].toLowerCase();
    const anchored = /^\s*(?:\/[\w-]+\s+)?(?:<hc\b[^>]*>\s*)?["'`]*Read\s/i.test(input);
    const prefix = input.slice(0, m.index);
    const suffix = input.slice(m.index + m[0].length);
    const directive = anchored && /^\s*(?:\/[\w-]+\s+)?(?:<hc\b[^>]*>\s*)?["'`]*Read\s+["'`]?[^\r\n"'`]*$/i.test(prefix)
      && /^["'`]?\s+and follow it\./i.test(suffix);
    const koreanDirective = /^\s*(?:[A-Za-z]:[\\/]|\/)?[^\s"'`]*$/.test(prefix) && /^를 다시 읽고 따라/.test(suffix);
    if (directive || koreanDirective) {
      const info = { stem, review: /-review-\d+/.test(stem), anchored };
      if (ev.conversationId) rememberAgySubSession(String(ev.conversationId), info);
      return info;
    }
  }
  const caller = callerInfo();
  if (caller.subStem) {
    return { stem: caller.subStem, review: /-review-\d+/.test(caller.subStem), anchored: false };
  }
  if (ev.conversationId) {
    return recallAgySubSession(String(ev.conversationId));
  }
  return null;
}

const REVIEW_READ = /^(read_file|view_file|grep_search|find_by_name)$/;
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
  } else if (/^(invoke_subagent|define_subagent|run_workflow|swarm)$/.test(name)) {
    block(`하위 세션(${s.stem})은 다른 서브에이전트나 워크플로를 실행하지 않는다 (${name})`);
  } else if (s.review && !REVIEW_READ.test(name)) {
    block(`검토 세션(${s.stem})은 읽기·검색 도구와 자기 보고 파일 쓰기만 쓴다 (${name}). 필요하면 보고에 적는다`);
  }
  return null;
}

// ---- secrets -----------------------------------------------------------------------------------------------------
function isSecretPath(p) {
  if (typeof p !== 'string' || !p) return false;
  const n = norm(p);
  return (SECRET.test(n) || SECRET_DIR.test(n)) && !SECRET_OK.test(n);
}
function isTestCred(p) { return typeof p === 'string' && !!p && TEST_CRED.test(norm(p)); }
const SRC_EXT = '(?:[cm]?js|jsx|tsx?|py|java|kt|kts|scala|go|rs|rb|php|cs|fs|swift|dart|c|cc|cpp|cxx|h|hpp|sql|graphql|gql|proto|vue|svelte|astro)';
function looksSecretGlob(g) {
  return typeof g === 'string' && new RegExp(
    `\\.env(?![.\\w]*(example|sample|template|defaults|dist|schema|md|ts|js|mjs|cjs))(?!\\.d\\.ts)(?!\\.(?:test|ci)$)(?!\\w)|credentials(?![^\\\\/]*\\.${SRC_EXT}$)|oauth_creds|mcp_oauth_tokens|mcp_config|application_default_credentials|\\.pem(?![.\\w])|\\.key(?![.\\w])|\\.jks(?![.\\w])|\\.keystore(?![.\\w])|id_rsa|id_ed25519|netrc|npmrc|pypirc|terraform\\.tfstate|(?<![a-z0-9])test[-_]?accounts?[^\\\\/]*\\.json|cookies?\\.txt|\\.cookies?(?![.\\w])|storage[-_]?state[^\\\\/]*\\.json`,
    'i'
  ).test(g);
}

// ---- protected files ---------------------------------------------------------------------------------------------
const KIT = absPath(dirname(fileURLToPath(import.meta.url)), '..');
const KIT_REAL = realAbsPath(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = homedir();
const REGISTRATION = ['.claude/settings.json', '.codex/hooks.json', '.gemini/config/hooks.json'].map((f) => absPath(HOME, f));
const GLOBAL_AGENT_FILES = [
  '.claude/settings.json', '.claude/settings.local.json',
  '.codex/hooks.json', '.codex/config.toml',
  '.gemini/config/hooks.json', '.gemini/config/skills.json', '.gemini/config/plugins.json',
  '.gemini/config/mcp_config.json', '.gemini/config/config.json',
  '.gemini/antigravity-cli/settings.json',
].map((f) => absPath(HOME, f));
const GLOBAL_AGENT_DIRS = [
  '.codex/rules', '.claude/skills', '.claude/agents', '.claude/plugins',
  '.agents/skills', '.gemini/config/skills', '.gemini/config/plugins', '.gemini/config/sidecars',
].map((d) => absPath(HOME, d));
const PROJECT_CFG_RX = /(^|\/)(\.claude\/(settings[^/]*\.json|hooks(\/|$)|agents(\/|$)|plugins(\/|$)|rules(\/|$)|commands(\/|$))|\.mcp\.json|\.codex(\/|$)|\.gemini(\/|$)|[_.]agents?\/(hooks\.json|plugins\.json|skills\.json|rules(\/|$)|skills(\/|$)|plugins(\/|$)))/;

function inDir(ap, dir) { return ap === dir || ap.startsWith(dir + '/'); }
function inKit(ap) { return inDir(ap, KIT) || inDir(ap, KIT_REAL); }

function protectedWrite(cwd, p, keepsGuard, isDirDeleteOrMove = false) {
  const np = norm(p);
  if (!np) return null;
  const ap = absPath(cwd, np);
  const rp = realAbsPath(cwd, np);
  const inKitCwd = inKit(absPath(cwd, '.')) || inKit(realAbsPath(cwd, '.'));
  const isWorkerOrSub = () => {
    if (/[\\/]\.worktrees([\\/]|$)/i.test(cwd)) return true;
    const caller = callerInfo();
    return !!(caller.isWorker || caller.subStem);
  };
  if (/(^|\/)\.git\/(hooks(\/|$)|config$)/.test(ap) || /(^|\/)\.git\/(hooks(\/|$)|config$)/.test(rp)) {
    return `Git 훅·설정 파일 변경 (${p}). pre-push 훅은 init.ps1이 설치한다`;
  }
  if (isDirDeleteOrMove && (/(^|\/)\.git$/.test(ap) || /(^|\/)\.git$/.test(rp))) {
    return `Git 저장소 메타데이터(.git) 삭제·이동 (${p})`;
  }
  if (/(^|\/)handoff\/[^/]+\/(approved\.json|accepted\.json|approvals(\/|$)|verify(\/|$))/.test(ap) || /(^|\/)handoff\/[^/]+\/(approved\.json|accepted\.json|approvals(\/|$)|verify(\/|$))/.test(rp)) {
    return `검증·승인·수락 증거 파일 직접 변경 (${p}). verify.ps1로만 갱신한다`;
  }
  if (isDirDeleteOrMove && (/(^|\/)handoff(\/[^/]+)?$/.test(ap) || /(^|\/)handoff(\/[^/]+)?$/.test(rp))) {
    return `검증·승인·수락 증거가 담긴 handoff 폴더 통째 삭제·이동 (${p})`;
  }
  const rf = rateFilePath();
  if (rf) {
    const rfAbs = absPath(cwd, rf);
    if (ap === rfAbs || rp === rfAbs || (isDirDeleteOrMove && inDir(rfAbs, ap))) {
      return `호출 빈도 기록 파일 변경 (${p})`;
    }
  }
  if ((inKit(ap) || inKit(rp)) && !inKitCwd) return `다른 프로젝트 세션에서 agent-kit 파일 변경 (${p}). 키트 수정은 agent-kit 폴더 세션에서만 한다`;
  if ((inKit(ap) || inKit(rp)) && /\/local-defaults\.json$/.test(ap) && isWorkerOrSub()) return `작업자·하위 세션에서 local-defaults.json 변경 (${p}). 로컬 기본 모델은 사용자가 관리한다`;
  const isGlobalCfg = GLOBAL_AGENT_FILES.includes(ap) || GLOBAL_AGENT_FILES.includes(rp)
    || GLOBAL_AGENT_DIRS.some((d) => inDir(ap, d) || inDir(rp, d))
    || (isDirDeleteOrMove && [...GLOBAL_AGENT_FILES, ...GLOBAL_AGENT_DIRS].some((d) => inDir(d, ap) || inDir(d, rp)));
  const isProjectCfg = PROJECT_CFG_RX.test(ap) || PROJECT_CFG_RX.test(rp);
  if ((isGlobalCfg || isProjectCfg) && (!inKitCwd || isWorkerOrSub())) return `에이전트 권한·훅 설정 파일 변경 (${p}). 권한 설정은 사용자가 직접 관리한다`;
  if ((REGISTRATION.includes(ap) || REGISTRATION.includes(rp)) && !keepsGuard) return `훅 등록 파일에서 guard를 빼거나 비활성화·미치환 경로(<agent-kit>)로 바꾸는 변경 (${p})`;
  return null;
}

// ---- shell parsing -----------------------------------------------------------------------------------------------
// Replace characters inside single/double quotes with safe placeholders when splitting non-script commands so commit
// messages like `git commit -m "fix: (type .env.local) a -> .git/hooks/pre-push"` never trigger false positives.
function maskQuotedText(cmd) {
  let out = '', quote = '', i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) { quote = ''; out += c; i++; continue; }
      if (c === '\\' && quote === '"' && i + 1 < cmd.length) { out += '  '; i += 2; continue; }
      out += /[A-Za-z0-9_./:\\-]/.test(c) ? c : ' ';
      i++; continue;
    }
    if (c === '"' || c === "'") { quote = c; out += c; i++; continue; }
    out += c; i++;
  }
  return out;
}

function splitUnquoted(cmd, fine = false) {
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
    if (c === '@' && /["']/.test(cmd[i + 1]) && /[\r\n]/.test(cmd[i + 2])) { here = cmd[++i]; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    const isAndOr = (c === '&' && cmd[i + 1] === '&') || (c === '|' && cmd[i + 1] === '|');
    const isSep = isAndOr || /[;|\r\n]/.test(c);
    const isFineSep = fine && (c === '`' || c === '(' || (c === '{' && !/[$@]/.test(cmd[i - 1] || '')));
    if (isSep || isFineSep) {
      const slice = cmd.slice(start, i).replace(/[\s})]+$/, '').trim();
      if (slice) result.push(slice);
      if (isAndOr) i++;
      start = i + 1;
    }
  }
  const tail = cmd.slice(start).replace(/[\s})]+$/, '').trim();
  if (tail) result.push(tail);
  return result;
}

function coarse(cmd) { return splitUnquoted(cmd, false); }
function segments(cmd) { return splitUnquoted(cmd, true); }
function agentSegments(cmd) { return splitUnquoted(cmd, true); }

function stripOuterQuotes(s) {
  const t = String(s || '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    const inner = t.slice(1, -1);
    return t.startsWith('"') ? inner.replace(/\\"/g, '"') : inner.replace(/''/g, "'");
  }
  return t;
}

function cmdScriptIndex(w) {
  if (!/^cmd$/i.test(verbOf(w[0] || ''))) return -1;
  for (let idx = 1; idx < w.length; idx++) {
    const t = norm(w[idx]);
    if (/^\/[ck]$/i.test(t)) return idx + 1 < w.length ? idx + 1 : -1;
    if (/^\/(?:[dsqua]|e:(?:on|off)|v:(?:on|off)|t:[0-9a-f]{1,2})$/i.test(t)) continue;
    break;
  }
  return -1;
}

// Extract nested shell scripts passed via `powershell -Command "..."`, `bash -c "..."`, `cmd [/d] /c "..."` so role/file
// checks cannot be bypassed by wrapping a command in a nested shell string.
function expandNestedShellScripts(segs, depth = 0) {
  if (depth >= 2) return segs;
  const out = [...segs];
  for (const seg of segs) {
    const w = (seg.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []).filter(Boolean);
    if (w.length < 2) continue;
    const v = verbOf(w[0]).toLowerCase();
    if (/^(powershell|pwsh)$/.test(v)) {
      const k = w.findIndex((x, idx) => idx > 0 && /^-(?:c|command)$/i.test(norm(x)));
      if (k >= 0 && w[k + 1]) {
        const inner = stripOuterQuotes(w.slice(k + 1).join(' '));
        if (inner && inner !== seg) out.push(...expandNestedShellScripts(segments(inner), depth + 1));
      }
    } else if (/^(bash|sh|zsh|dash|ksh)$/.test(v)) {
      const k = w.findIndex((x, idx) => idx > 0 && /^-[a-z]*c$/i.test(norm(x)));
      if (k >= 0 && w[k + 1]) {
        const inner = stripOuterQuotes(w[k + 1]);
        if (inner && inner !== seg) out.push(...expandNestedShellScripts(segments(inner), depth + 1));
      }
    } else {
      const ci = cmdScriptIndex(w);
      if (ci > 0) {
        const inner = stripOuterQuotes(w.slice(ci).join(' '));
        if (inner && inner !== seg) out.push(...expandNestedShellScripts(segments(inner), depth + 1));
      }
    }
  }
  return out;
}

function rawWords(seg) {
  const w = (seg.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []).filter(Boolean);
  for (let n = 0; n < 16; n++) {
    const a = w[0] || '';
    if (w.length > 1 && /^(&|\}|then|do|else|try|finally|if|while|until|elif|!|command|builtin|time|exec|env|sudo|nohup)$/i.test(a)) w.shift();
    else if (/^\$[\w:]+$/.test(a) && w[1] === '=') w.splice(0, 2);
    else if (/^\$[\w:]+=$/.test(a)) w.shift();
    else if (/^\$[\w:]+=./.test(a)) w[0] = a.replace(/^\$[\w:]+=/, '');
    else if (w.length > 1 && /^[A-Za-z_]\w*=\S*$/.test(a)) w.shift();
    else break;
  }
  return w;
}

function words(seg, unwrapCmdScript = false) {
  const w = rawWords(seg);
  for (let n = 0; n < 8; n++) {
    const a = w[0] || '';
    const ci = cmdScriptIndex(w);
    if (ci > 0) {
      w.splice(0, ci);
      const script = w[0]?.replace(/^(["'])(.*)\1$/, '$2');
      if (unwrapCmdScript && script !== w[0]) return words(script);
    } else if (/^hc$/i.test(verbOf(a)) && /^exec$/i.test(w[hcSubcommandIndex(w)] || '')) {
      w.splice(0, hcSubcommandIndex(w) + 1);
      w.splice(0, hcArgumentIndex(w, 0, /^--(on|cwd|env|timeout)$/i));
    } else break;
  }
  return w;
}

function verbOf(word) { return String(word || '').replace(/^[({]+/, '').replace(/^["'`]+|["'`]+$/g, '').replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|ps1)$/i, ''); }

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

function extractAgyPrompt(agyArgs) {
  for (let idx = 0; idx < agyArgs.length; idx++) {
    const o = norm(agyArgs[idx]);
    if (/^(?:-i|-p|--prompt(?:-interactive)?|--print)$/i.test(o) && agyArgs[idx + 1] !== undefined && !norm(agyArgs[idx + 1]).startsWith('-')) {
      return agyArgs[idx + 1];
    }
    const m = /^(?:--prompt(?:-interactive)?|--print)=(.*)$/i.exec(o);
    if (m) return m[1];
  }
  const valueFlags = /^--(?:model|mode|settings|log-file|add-dir|workspace|cwd)$/i;
  for (let idx = 0; idx < agyArgs.length; idx++) {
    const o = norm(agyArgs[idx]);
    if (o === '--') return agyArgs[idx + 1] || '';
    if (valueFlags.test(o)) { idx++; continue; }
    if (o.startsWith('-')) continue;
    return agyArgs[idx];
  }
  return agyArgs.at(-1) || '';
}

const LAUNCHERS = /^(claude|codex|agy|gemini|npx|npm|bunx|pnpm|yarn|node|bash|sh|env|sudo|start|start-process|cmd|powershell|pwsh)$/i;
const AGY_PROGRAM = /^(agy|antigravity)$/i;
const WRAPPER = /^(bash|sh|env|sudo|start|start-process|cmd|powershell|pwsh)$/i;

const HC_FALLBACK = process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA || join(HOME, 'AppData', 'Local'), 'Programs', 'herdr-core', 'hc.exe') : '';

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
  } catch {}
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
  const roleEnv = String(process.env.AGENTKIT_ROLE || '').trim();
  // Explicit sub-session role (`AGENTKIT_ROLE=sub-...`) strictly narrows privileges and overrides an inherited parent
  // HC_TERMINAL_ID without spawning `hc get`. Non-sub roleEnv values cannot clear a worker terminal's identity (`hcName`).
  const envSub = /^((?:sub|agy)-[a-z0-9_.-]+-(?:review|research|flash)-\d+)$/i.exec(roleEnv)
    || /^sub:([a-z0-9_.-]+)$/i.exec(roleEnv);
  if (envSub) {
    const stem = envSub[1].toLowerCase();
    callerCache = { id, name: stem, subStem: stem, isWorker: false };
    return callerCache;
  }
  const t = id ? hcGetTerminal(id) : null;
  const hcName = typeof t?.name === 'string' ? t.name : '';
  const name = hcName || roleEnv;
  const sub = /^((?:sub|agy)-[a-z0-9_.-]+-(?:review|research|flash)-\d+)$/i.exec(hcName);
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

// ---- rate limits (atomic write + merged primary/fallback read) ---------------------------------------------------
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
function enforceRateLimits(actions) {
  if (!actions.length) return;
  const primary = rateFilePath();
  if (!primary) return;
  const fallback = join(tmpdir(), 'agent-kit-hc-rate.json');
  const now = Number(process.env.AGENTKIT_NOW_MS) || Date.now();
  let events = readRateEvents(primary, now);
  if (!process.env.AGENTKIT_RATE_FILE && existsSync(fallback)) {
    const fbEvents = readRateEvents(fallback, now);
    if (fbEvents.length) {
      const seen = new Set(events.map((e) => `${e.ts}:${e.kind}:${e.name || e.target || ''}`));
      for (const e of fbEvents) {
        const key = `${e.ts}:${e.kind}:${e.name || e.target || ''}`;
        if (!seen.has(key)) { seen.add(key); events.push(e); }
      }
      events.sort((a, b) => a.ts - b.ts);
    }
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
  if (!atomicWriteJson(primary, { events }) && !process.env.AGENTKIT_RATE_FILE) {
    atomicWriteJson(fallback, { events });
  }
}

const SEARCH_VALUE_OPT = /^(-path|-literalpath|-include|-exclude|-encoding|-context|-f|--file|--include|--exclude|--exclude-dir|-g|--glob|-t|--type|-A|-B|-C|-m|--max-count)$/i;
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

const FILE_TOOLS = ['Read', 'Edit', 'Write', 'NotebookEdit', 'Grep', 'Glob', 'apply_patch'];
function shellCommand(tool, inp) {
  const shellName = /^(Bash|PowerShell|shell|local_shell|exec_command|unified_exec)$/i.test(tool);
  const c = inp.command !== undefined ? inp.command : inp.cmd;
  if (!shellName && (FILE_TOOLS.includes(tool) || c === undefined)) return null;
  if (Array.isArray(c)) {
    const a = c.map(String);
    const exe = (a[0] || '').replace(/^.*[\\/]/, '').replace(/\.(exe|cmd)$/i, '').toLowerCase();
    let k = -1;
    if (/^(bash|sh|zsh|dash|ksh)$/.test(exe)) k = a.findIndex((x, i) => i > 0 && /^-l?c$/.test(x));
    else if (/^(powershell|pwsh)$/.test(exe)) k = a.findIndex((x, i) => i > 0 && /^-(c|command)$/i.test(x));
    else if (exe === 'cmd') k = a.findIndex((x, i) => i > 0 && /^\/[ck]$/i.test(x));
    return k >= 0 ? a.slice(k + 1).join(' ') : a.join(' ');
  }
  return typeof c === 'string' ? c : '';
}

// Opt-in diagnostic only (`AGENTKIT_DEBUG_SHAPES=1`) so ordinary tool calls incur zero temp-dir I/O or metadata exposure.
function recordShape(ev) {
  if (process.env.AGENT_GUARD_TEST || process.env.AGENTKIT_DEBUG_SHAPES !== '1') return;
  try {
    const base = process.platform === 'win32'
      ? (process.env.LOCALAPPDATA || join(HOME, 'AppData', 'Local'))
      : join(HOME, '.cache');
    const dir = join(base, 'agent-kit', 'shapes');
    mkdirSync(dir, { recursive: true });
    const inp = ev.tool_input || (ev.toolCall && ev.toolCall.args) || {};
    const name = ev.tool_name || (ev.toolCall ? 'agy-' + ev.toolCall.name : 'none');
    const types = Object.fromEntries(Object.keys(inp).map((k) => [k, Array.isArray(inp[k]) ? 'array' : typeof inp[k]]));
    const safe = String(name).replace(/[^\w.-]/g, '_').slice(0, 40);
    writeFileSync(join(dir, `last-${safe}.json`), JSON.stringify({ time: new Date().toISOString(), hook_event_name: ev.hook_event_name || ev.hookEventName, tool_name: name, keys: Object.keys(ev), tool_input: types }, null, 1));
  } catch {}
}

function checkInlineCodeTokens(cwd, codeText, checkProtected = true) {
  const cleaned = String(codeText || '').replace(/--(env-file|cacert|cafile|capath|cert|key|public-key|private-key|ssl-key|ssl-cert|tls-key|tls-cert)(=|\s+)\S+/gi, ' ');
  const mutates = /\b(writeFileSync|writeFile|appendFileSync|copyFileSync|unlinkSync|rmSync|rmdirSync|renameSync|WriteAllText|WriteAllLines|WriteAllBytes|AppendAllText|Delete|Move|Copy|open\s*\([^)]*['"][wa+])/i.test(cleaned);
  for (const tok of cleaned.split(/[\s|;&<>()=,:{}'"]+/).filter(Boolean)) {
    if (isSecretPath(tok) && !(/\.(key|pem|p12|pfx|jks|keystore)$/i.test(norm(tok)) && !/[\\/]/.test(tok))) {
      block(`비밀 파일을 읽는 명령 (${norm(tok)})`);
    }
    if (isTestCred(tok) && /\b(readFileSync|readFile|ReadAllText|ReadAllLines|open\s*\()/i.test(cleaned)) {
      block(`테스트 자격증명 파일 열람 (${norm(tok)}). 테스트 도구 인자로만 쓴다`);
    }
    if (checkProtected && mutates) {
      const why = protectedWrite(cwd, tok, false, /\b(rmSync|rmdirSync|unlinkSync|Delete)\b/i.test(cleaned));
      if (why) block(why);
    }
  }
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => { try { main(); } catch { process.exit(0); } });

function main() {
  let ev;
  try { ev = JSON.parse(raw); } catch { process.exit(0); }
  if (!ev || typeof ev !== 'object') process.exit(0);
  recordShape(ev);
  PRE = !ev.toolCall && ev.hook_event_name === 'PreToolUse';
  let agyAuto = null;
  const agySub = ev.toolCall ? subSession(ev) : null;
  if (ev.toolCall) {
    AGY = true;
    const n = String(ev.toolCall.name || ''), a = ev.toolCall.args || {};
    const evCwd = ev.cwd || (ev.workspacePaths || [])[0] || process.cwd();
    agyAuto = subSessionScope(ev, n, a);
    if (n === 'browser_navigate') {
      const u = String(a.Url || a.url || '');
      if (/^file:/i.test(u)) {
        const fp = decodeURIComponent(u.replace(/^file:\/\/\/?/i, ''));
        if (isSecretPath(fp) || isTestCred(fp)) block(`브라우저로 비밀·자격증명 파일 접근 (${fp})`);
      }
    } else if (n === 'run_workflow') {
      if (a.Script) checkInlineCodeTokens(evCwd, String(a.Script), true);
      if (a.ScriptPath && isSecretPath(String(a.ScriptPath))) block(`비밀 파일 접근 (${a.ScriptPath})`);
    }
    const map = {
      read_file: ['Read', { file_path: a.Path }],
      view_file: ['Read', { file_path: a.Path }],
      write_file: ['Write', { file_path: a.Path, content: a.Content }],
      edit_file: ['Edit', { file_path: a.Path, old_string: a.Target, new_string: a.Replacement }],
      run_command: ['Bash', { command: a.CommandLine }],
      grep_search: ['Grep', { path: a.SearchPath || '', glob: Array.isArray(a.Includes) ? (a.Includes[0] || '') : '' }],
      find_by_name: ['Glob', { path: a.SearchDirectory || '', pattern: a.Pattern || '' }],
    };
    const m = map[n];
    ev = { tool_name: m ? m[0] : 'agy:' + n, tool_input: m ? m[1] : {}, cwd: evCwd };
  }
  const tool = ev.tool_name || '';
  const inp = ev.tool_input || {};
  const cwd = ev.cwd || process.cwd();
  const hasGuard = (s) => {
    const str = String(s || '');
    return /guard\.mjs/.test(str) && !/<agent-kit>/i.test(str) && !/"disableAllHooks"\s*:\s*true/.test(str) && !/"enabled"\s*:\s*false/.test(str);
  };

  const patchText = String(inp.command || inp.patch || inp.input || '');
  const isPatch = tool === 'apply_patch' || (['Edit', 'Write'].includes(tool) && !inp.file_path && /^\*\*\* (Add File|Update File|Delete File|Move to):/m.test(patchText));
  if (isPatch) {
    const removesGuard = (/^-.*guard\.mjs/m.test(patchText) && !/^\+.*guard\.mjs/m.test(patchText))
      || /^\+.*"(?:disableAllHooks|enabled)"\s*:\s*(?:true|false)/m.test(patchText);
    for (const m of patchText.matchAll(/^\*\*\* (Add File|Update File|Delete File|Move to): *(.+?)\s*$/gm)) {
      const [, kind, p] = m;
      if (isSecretPath(p)) block(`비밀 파일 편집 (${p})`);
      if (isTestCred(p) && (kind === 'Update File' || kind === 'Move to' || (kind === 'Add File' && existsSync(resolve(cwd, norm(p)))))) {
        block(`테스트 자격증명 파일 편집·덮어쓰기 (${p}). 새로 만들거나 테스트 도구 인자로만 쓴다`);
      }
      const keeps = kind === 'Update File' ? !removesGuard : kind === 'Add File' ? hasGuard(patchText) : false;
      const why = protectedWrite(cwd, p, keeps, kind === 'Delete File');
      if (why) block(why);
    }
    process.exit(0);
  }
  if (['Read', 'Edit', 'Write', 'NotebookEdit'].includes(tool)) {
    const p = inp.file_path || inp.notebook_path;
    if (isSecretPath(p)) block(`비밀 파일 접근 (${p})`);
    if (tool !== 'Write' && isTestCred(p)) block(`테스트 자격증명 파일 열람 (${p}). 테스트 도구 인자로만 쓴다`);
    if (tool === 'Write' && isTestCred(p) && existsSync(resolve(cwd, norm(p)))) {
      block(`기존 테스트 자격증명 파일 덮어쓰기 (${p}). 기존 자격증명 파일은 보존한다`);
    }
    if (tool !== 'Read' && typeof p === 'string' && p) {
      const keeps = tool === 'Write' ? hasGuard(inp.content)
        : !(hasGuard(inp.old_string) && !hasGuard(inp.new_string)) && !/"(?:disableAllHooks|enabled)"\s*:\s*(?:true|false)/.test(String(inp.new_string || ''));
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
    const currentBranch = (dir) => {
      const where = resolve(cwd, dir || '.');
      if (branchCache.has(where)) return branchCache.get(where);
      let b = '';
      try { b = execSync('git branch --show-current', { cwd: where, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { b = ''; }
      branchCache.set(where, b);
      return b;
    };
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

    const coarseSegs = expandNestedShellScripts(coarse(cmd));
    for (const seg of coarseSegs) {
      const rw = rawWords(seg);
      const rawVerb = verbOf(rw[0]).toLowerCase();
      // Guard `hc exec` BEFORE `words()` unwraps it, so sub-sessions / workers / manual mode cannot escape onto other terminals.
      if (rawVerb === 'hc') {
        const rHcIdx = hcSubcommandIndex(rw);
        const rHcSub = norm(rw[rHcIdx] || '').toLowerCase();
        if (rHcSub === 'exec') {
          const caller = callerInfo();
          const subStem = agySub?.stem || caller.subStem;
          if (subStem) block(`하위 세션(${subStem})은 hc exec을 실행하지 않는다`);
          const onIdx = rw.findIndex((t, idx) => idx > rHcIdx && /^--on(?:=|$)/i.test(norm(t)));
          if (onIdx >= 0) {
            if (policyOf(null).crossMode === 'manual') block('수동 인계(agentkit.crossAgentMode=manual) 모드에서는 hc exec --on을 쓰지 않는다');
            const onTarget = /^--on=/i.test(norm(rw[onIdx])) ? norm(rw[onIdx]).slice(5) : norm(rw[onIdx + 1] || '');
            if (caller.isWorker) {
              const { parent } = hcTargetInfo(onTarget);
              if (!parent || parent !== caller.id) block(`작업자 세션(${caller.name})은 자기가 띄운 직계 자식 외 터미널에서 hc exec --on을 실행하지 않는다`);
            }
          }
        }
      }

      const w = words(seg, true);
      const verb = verbOf(w[0]);
      const hcInfo = /^hc$/i.test(verb) ? hcRunInfo(w) : null;
      const hcRun = !!hcInfo;
      const isAgentCli = /^(claude|codex|agy|antigravity|gemini)$/i.test(verb);
      if (BYPASS.test(seg) && (LAUNCHERS.test(verb) || hcRun)) block('권한·훅 우회 플래그');
      if (isAgentCli && !w.slice(1).every((x) => /^(--help|-h|--version|-v)$/i.test(norm(x))) && !(w.length === 2 && /^models$/i.test(norm(w[1])))) {
        const activeSub = agySub?.stem || callerInfo().subStem;
        if (activeSub) block(`하위 세션(${activeSub})은 다른 에이전트 CLI(${verb})를 실행하지 않는다`);
      }
      if (hcRun && /(^|\s)--(parent|outlive-parent)\b/.test(seg)) block('hc run의 부모 추적을 바꾸는 옵션');
      if (hcRun && /^task-[a-z0-9_.-]+$/i.test(hcInfo.name || '') && (/[\\/]\.worktrees([\\/]|$)/i.test(cwd) || callerInfo().isWorker)) {
        block('작업자 세션은 다른 작업자(task-*)를 실행하지 않는다');
      }
      if (hcRun && hcInfo.targetVerb === 'codex' && !hcInfo.optTokens.some((t) => /^--no-daemon$/i.test(norm(t)))) {
        block('hc run으로 codex를 띄울 때는 --no-daemon이 필요하다(없으면 부모 추적이 끊긴다)');
      }
      const revTarget = (hcRun && hcInfo.name) ? hcInfo.name
        : isAgentCli ? (/(?:handoff[\\/]|AGENTKIT_ROLE\s*=\s*["']?)((?:sub|agy)-[a-z0-9_.-]*-review-\d+)(?:\.md\b|["'\s]|$)/i.exec(seg)?.[1] || '')
        : '';
      if (revTarget) {
        const revCap = /^((?:sub|agy)-[a-z0-9_.-]*-review-(\d+))$/i.exec(revTarget);
        if (revCap && Number.parseInt(revCap[2], 10) > 4) block(`하위 검토 세션(${revCap[1]})의 누적 실행 번호가 상한(4: 빈틈 검토 2회 + 완료 전 검토 2회)을 넘었다. 상위 세션이나 사용자에게 보고한다`);
      }
      if (/^(node|python|python3|py|deno|bun|powershell|pwsh)$/i.test(verb)) {
        const isPsFile = /^(powershell|pwsh)$/i.test(verb) && w.some((x) => /^-file$/i.test(norm(x)));
        if (!isPsFile) checkInlineCodeTokens(cwd, w.slice(1).join(' '), true);
      }
      if (/\[(?:system\.)?io\.file\]::/i.test(seg)) {
        checkInlineCodeTokens(cwd, seg, true);
      }
      if (/(^|[\s;$:{(])GIT_CONFIG_(COUNT|PARAMETERS|KEY_\d+|VALUE_\d+|GLOBAL|SYSTEM)\s*=/.test(seg)) block('GIT_CONFIG_* 환경 변수(pre-push 훅·정책 우회)');
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
        const isDirectAgyLaunch = !hcRun && agyArgs.some((o) => /^(?:-i|-p|--prompt(?:-interactive)?|--print)(?:=|$)/i.test(norm(o)));
        const promptText = (hcRun || isDirectAgyLaunch) ? extractAgyPrompt(agyArgs) : '';
        const directSubMatch = isDirectAgyLaunch
          ? (/handoff[\\/]((?:sub|agy)-[a-z0-9_.-]*-(?:review|research)-\d+)\.md\b/i.exec(promptText)
            || /AGENTKIT_ROLE\s*=\s*["']?((?:sub|agy)-[a-z0-9_.-]*-(?:review|research)-\d+)/i.exec(seg))
          : null;
        const sub = hcRun && hcInfo.name
          ? /^((?:sub|agy)-[a-z0-9_.-]*-(?:review|research)-\d+)$/i.exec(hcInfo.name)
          : directSubMatch;
        if (sub) {
          if (!new RegExp(`handoff[\\\\/]${reEsc(sub[1])}\\.md`, 'i').test(promptText)) {
            block(`하위 세션(${sub[1]})의 시작 문장에 handoff/${sub[1]}.md가 없다`);
          }
          if (modeValue !== 'plan') block(`하위 세션(${sub[1]})은 --mode plan으로 띄운다(모드를 주지 않으면 auto 모드로 돈다)`);
        }
        if (isDirectAgyLaunch) rateActions.push({ kind: 'run', agy: true, name: sub ? sub[1].toLowerCase() : '' });
      }
      if (verb !== 'hc') continue;
      const hcIndex = hcSubcommandIndex(w);
      const hcSub = norm(w[hcIndex] || '').toLowerCase();
      const hcHelp = w.length === hcIndex + 2 && /^(--help|-h)$/.test(norm(w[hcIndex + 1]));
      if (hcRun && !hcHelp) {
        rateActions.push({ kind: 'run', agy: AGY_PROGRAM.test(hcInfo.targetVerb), name: (hcInfo.name || '').toLowerCase() });
      }
      if (/^(send|keys|interrupt)$/.test(hcSub) && !hcHelp) {
        const targetIndex = hcArgumentIndex(w, hcIndex + 1, /^--(if|timeout|wait|force)$/i);
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

    const fineSegs = expandNestedShellScripts(segments(cmd));
    for (const seg of fineSegs) {
      const w = words(seg, true);
      const verb = verbOf(w[0]).toLowerCase();
      const unquotedSeg = maskQuotedText(seg);

      if (verb === 'hc') {
        const hcIndex = hcSubcommandIndex(w);
        const hcSub = norm(w[hcIndex] || '').toLowerCase();
        const subStem = agySub?.stem || (/^(run|send|keys|interrupt|kill|rm|exec)$/.test(hcSub) ? callerInfo().subStem : null);
        if (subStem && /^(run|send|keys|interrupt|kill|rm|exec)$/.test(hcSub)) block(`하위 세션(${subStem})은 다른 에이전트 세션을 실행하거나 제어하지 않는다 (hc ${hcSub})`);
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

      const scriptTokens = w.map((tok) => norm(tok));
      const runsVerify = (/^(powershell|pwsh)$/i.test(verb) && scriptTokens.some((tok) => /(?:^|[\\/])verify\.ps1$/i.test(tok))) || (/^verify$/i.test(verb) && /(?:^|[\s"'\\/])verify\.ps1(?:["'\s]|$)/i.test(seg));
      const runsInit = (/^(powershell|pwsh)$/i.test(verb) && scriptTokens.some((tok) => /(?:^|[\\/])init\.ps1$/i.test(tok))) || (/^init$/i.test(verb) && /(?:^|[\s"'\\/])init\.ps1(?:["'\s]|$)/i.test(seg));
      if (runsVerify || runsInit) {
        const caller = callerInfo();
        const subStem = agySub?.stem || caller.subStem;
        if (subStem) block(`하위 세션(${subStem})은 ${runsVerify ? 'verify.ps1' : 'init.ps1'}을 실행하지 않는다`);
        const isWorker = /[\\/]\.worktrees([\\/]|$)/i.test(cwd) || caller.isWorker;
        if (isWorker && runsVerify && scriptTokens.some((tok) => /^-(Prepare|Prep|Pre|Pr|Accept|Accep|Acce|Acc|Ac|A)$/i.test(tok))) {
          block('작업자 세션은 verify.ps1 -Prepare / -Accept를 실행하지 않는다(설계자 전용)');
        }
        if (isWorker && runsInit && scriptTokens.some((tok) => /^-(Submission|Subm\w*|Sub|Su|S|ProtectedBranches|Prot\w*|P|CrossAgentMode|Cross\w*|C|MaxVerifyFailures|Max\w*|M|Base|Bas|Ba|B|TrackSpec|Track\w*)$/i.test(tok))) {
          block('작업자 세션은 init.ps1로 저장소 제출·호출 정책을 변경하지 않는다');
        }
      }

      // Worker PR merge gate: require `--match-head-commit` so an unpushed/unaccepted remote SHA cannot be merged by mistake.
      if (verb === 'gh' && norm(w[1] || '').toLowerCase() === 'pr' && norm(w[2] || '').toLowerCase() === 'merge') {
        const caller = callerInfo();
        if (caller.isWorker || /[\\/]\.worktrees([\\/]|$)/i.test(cwd)) {
          if (!w.some((tok) => /^--match-head-commit(?:=|$)/i.test(norm(tok)))) {
            block('작업자가 gh pr merge를 실행할 때는 수락 커밋 일치를 보장하도록 --match-head-commit <수락 SHA>를 지정해야 한다');
          }
        }
      }

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
      let args = searchArgs(verb, w);
      if (/^(node|python|python3|py|curl|npx|deno|bun)$/i.test(verb)) args = args.replace(/--(env-file|cacert|cafile|capath|cert|key|public-key|private-key|ssl-key|ssl-cert|tls-key|tls-cert)(=|\s+)\S+/gi, ' ');

      if (READERS.test(verb) || hcFile || /^(show|diff|cat-file|grep|log)$/.test(gitSub)) {
        const isCopyMove = /^(cp|copy|copy-item|cpi|mv|move|move-item|mi|ren|rename|rename-item|rni)$/i.test(verb);
        const isViewer = VIEWERS.test(verb) || hcFile;
        const isCurlHeaderDump = verb === 'curl' && w.some((tok) => /^(-[A-Za-z]*[vi][A-Za-z]*|--verbose|--include|--trace(?:-ascii)?)$/i.test(norm(tok)));
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
          if (isCurlHeaderDump && isTestCred(tok)) {
            block(`테스트 쿠키·자격증명 파일을 curl -v/-i/--trace와 함께 쓰면 헤더 원문이 대화 기록에 남는다 (${norm(tok)}). -v/-i를 빼거나 상태 코드(-w "%{http_code}")만 확인한다`);
          }
        }
        if (/\.env\*|\.env\?/.test(args)) block('비밀 파일 와일드카드 읽기');
      }

      for (const m of unquotedSeg.matchAll(/<\s*([^\s<>|;&()]+)/g)) {
        if (isSecretPath(m[1]) || isTestCred(m[1])) block(`비밀 파일을 읽는 명령 (${norm(m[1])})`);
      }

      if (MUTATORS.test(verb) || (verb === 'sed' && /(^|\s)-i/.test(seg))) {
        const isCopy = /^(cp|copy|copy-item|cpi)$/i.test(verb);
        const isDeleteOrMove = /^(rm|del|erase|rd|rmdir|remove-item|ri|mv|move|move-item|mi|ren|rename|rename-item|rni)$/i.test(verb);
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
          const why = protectedWrite(cwd, tok, false, isDeleteOrMove);
          if (why) block(why);
        }
      }

      // Output redirection (`>`, `>>`, `1>`), excluding arrow tokens (`->`, `=>`) and masked quoted text.
      for (const m of unquotedSeg.matchAll(/(?:^|[^<>&=-])(?:\d+)?>>?\s*("[^"]+"|'[^']+'|[^\s;|&>]+)/g)) {
        const why = protectedWrite(cwd, m[1], false, false);
        if (why) block(why);
      }

      if (verb === 'git' && /core\.hooksPath/i.test(w.slice(1, i).join(' '))) block('git -c core.hooksPath(pre-push 훅 우회)');
      if (gitSub === 'config' && /core\.hooksPath/i.test(seg) && !/^(get|list|unset)$/.test(w[i + 1] || '')
          && !/(^|\s)(--get|--get-all|--get-regexp|--list|-l|--unset|--unset-all)(\s|$)/.test(seg)
          && w.filter((x, idx) => idx > i && !x.startsWith('-')).length >= 2) block('git config core.hooksPath 변경(pre-push 훅 우회)');
      // Block direct `git config agentkit.*` edits/unsets by agents (`init.ps1 -GitSetup` is the sole policy writer).
      if (gitSub === 'config' && /\bagentkit\.[a-z]/i.test(seg) && !/^(get|list)$/.test(w[i + 1] || '')
          && !/(^|\s)(--get|--get-all|--get-regexp|--list|-l)(\s|$)/.test(seg)) {
        const isUnset = /(^|\s)(--unset|--unset-all|unset)(\s|$)/.test(seg);
        const posAfterConfig = w.filter((x, idx) => idx > i && !x.startsWith('-'));
        if (isUnset || posAfterConfig.length >= 2) {
          block('git config agentkit.* 직접 변경 차단(저장소 정책은 init.ps1 -GitSetup으로만 변경한다)');
        }
      }
      if (gitSub === 'config' && /alias\./i.test(seg) && /--no-veri|hooksPath|send-pack/i.test(seg)) block('git alias로 pre-push 훅 우회');
      if (gitSub === 'send-pack') block('git send-pack(pre-push 훅을 거치지 않는 push)');
      if (gitSub === 'push' && /(^|[\s"'])--no-veri\w*/i.test(seg)) block('git push --no-verify(pre-push 훅 우회)');
      if (gitSub === 'push') {
        const pol = policyOf(gitDir);
        if (pol.local) block('push(이 저장소의 제출 방식은 local: 모든 push 차단. 바꾸려면 사용자가 init.ps1 -GitSetup -Submission으로 정한다)');
        const rest = w.slice(i + 1).join(' ').replace(/\s#.*$/, '');
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
