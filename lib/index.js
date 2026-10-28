/**
 * dsh-ledger-watch · 宿主半边
 *
 * 目的（对齐用户确认的定位）：**让模型真的在查账本、记坑、修正规则**。
 * 界面只是指示灯：显示「本会话有没有启用避坑/提升功能」。所以宿主这边要提供三样东西：
 *   ① 行为指标：本会话查了几次、记了几条（有证据，可核对）
 *   ② 启用判定：enabled = 本会话查过账本；needRecord = 本会话有失败工具调用却零记录
 *   ③ 规则库健康度：条目数 / 复发记录（规则失效待改）/ 修订记录（已自我修正）—— 这才是「自我升级」的指示灯
 *
 * 观测通道（对着真实代码核实过）
 *  1. ctx.on('tools/result', (exec, result) => …)：exec 字段 = callId/name/arguments/agent，
 *     会话归属取 exec.agent.session.id（见 DSH-011）
 *  2. ctx.on('session/event', (session, event) => …)
 *  3. 证据文件：宿主 console 读不到，只能落 JSON（见 DSH-007）
 *  4. report(clientBuild, note)：客户端回报自己，让「浏览器里跑的是哪一版」可见（PRC-013）
 *
 * 安全/健壮性（2026-10-27 评审后）：report 限长限速 + sanitize、evidence 默认关闭、
 * 原子写 + 失败可观测、blobOf 白名单、分类器结构化（脚本必须在命令位 / 文件必须落在账本目录）。
 *
 * @module dsh-ledger-watch
 */
import { writeFileSync, readFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
// ENTRY_RE 不再从 recall.js 导入：本文件已无逐行扫描（scanLedgerStats 复用 scanLedger）
import { scanLedger, recallFor, buildRecallText } from './recall.js';

const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods';

// 默认账本目录：用户家目录下的 skills 目录（不硬编码任何机器路径）
const DEFAULT_LEDGER_DIR = join(homedir(), '.agents', 'skills', 'lesson-ledger');
const EVIDENCE_NAME = '.watch.json';

const MAX_EVENTS_PER_SESSION = 40;
const MAX_SESSIONS = 24;
const MAX_DIAG = 24;
const WRITE_THROTTLE_MS = 200;
const BLOB_LIMIT = 4000;
const SCRIPT_ARG_LIMIT = 1024;
const MAX_CLIENT_BUILD = 64;
const MAX_CLIENT_NOTE = 256;
const REPORT_MIN_INTERVAL_MS = 2000;
const MAX_NOTE_LEN = 200;
const LEDGER_SCAN_INTERVAL_MS = 30000;
/** 每会话召回注入的字符预算：防止整会话无界注入把上下文吃满（验收 2 判定为「整会话无界」）。 */
const RECALL_SESSION_BUDGET = 6000;

/** 构建标记：改 lib/ 就更新它，用来判断进程里跑的是哪一版（见 PRC-013）。 */
const BUILD = '2026-10-28 17:05 +08 · session-identity.1';

/** 账本脚本 → 动作。只认「真的在命令位被调用」，不做全文包含匹配。 */
const SCRIPT_RULES = [
  { name: 'add-lesson.ps1', action: 'record', label: 'add-lesson（记条目）' },
  { name: 'inbox.ps1', action: 'record', label: 'inbox（收件箱）' },
  { name: 'brief.ps1', action: 'query', label: 'brief（开工查询）' },
  { name: 'report.ps1', action: 'query', label: 'report（变更报告）' },
  { name: 'selftest.ps1', action: 'query', label: 'selftest（规则自检）' },
  { name: 'check-ledger.ps1', action: 'query', label: 'check-ledger（结构自检）' }
];
const COMMAND_TOOLS = { pwsh: 'command', bash: 'command', shell: 'command', cmd: 'command' };
const WRITE_TOOLS = ['write', 'edit'];
const SKILL_NAME = 'lesson-ledger';
// 账本条目 ID 正则只存在于 recall.js 一份（ENTRY_RE，`\d{3,}`）。
// 这里原来另抄了一份 `\d{3}`，两份手工同步 → 漏改一处就静默少报，故整份删除。

/* ---------- 基础工具 ---------- */
function isPlainObject(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }

function sanitize(value, max) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
}
function escapeRegExp(text) { return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function normPath(p) { return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); }
function isInside(dir, p) {
  const d = normPath(dir);
  const t = normPath(p);
  return t === d || t.startsWith(d + '/');
}
function baseNameOf(p) {
  const n = normPath(p);
  const i = n.lastIndexOf('/');
  return i < 0 ? n : n.slice(i + 1);
}
const BLOB_FIELDS = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'name', 'description'];
function blobOf(args) {
  try {
    if (typeof args === 'string') return args.slice(0, BLOB_LIMIT);
    if (!isPlainObject(args)) return '';
    const parts = [];
    for (const key of BLOB_FIELDS) {
      const value = args[key];
      if (typeof value === 'string' && value.length > 0) parts.push(key + '=' + value.slice(0, SCRIPT_ARG_LIMIT));
      if (parts.length >= 4) break;
    }
    return parts.join('\n').slice(0, BLOB_LIMIT);
  } catch (error) { return ''; }
}
function commandTextOf(toolName, args) {
  const key = COMMAND_TOOLS[String(toolName)];
  if (key === undefined || !isPlainObject(args)) return '';
  const value = args[key];
  return typeof value === 'string' ? value : '';
}
function filePathOf(args) {
  if (!isPlainObject(args)) return '';
  for (const key of ['file_path', 'path', 'filePath']) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}
function scriptInCommand(command) {
  if (typeof command !== 'string' || command.length === 0) return null;
  for (const line of command.split(/\r?\n/)) {
    const cleaned = line.replace(/^[a-z_]+=/i, '').trim();
    if (cleaned.length === 0 || cleaned.startsWith('#') || cleaned.startsWith('//')) continue;
    for (const rule of SCRIPT_RULES) {
      const n = escapeRegExp(rule.name);
      const tail = '($|[\\s"\';)|&])';
      const patterns = [
        '(^|[&;|(])\\s*(\\S*[\\\\/])?' + n + tail,        // 行首 / & / ; / | / ( 之后（可带路径）
        '[\\\\/]' + n + tail,                               // 任何路径形式
        '-f(?:ile)?\\s+(\\S*[\\\\/])?' + n + tail           // pwsh -File xxx.ps1
      ];
      for (const pattern of patterns) {
        if (new RegExp(pattern, 'i').test(cleaned)) return rule;
      }
    }
  }
  return null;
}
/**
 * 结构化分类：返回 null 表示与账本无关（不计数）。
 * @param toolName - 工具名
 * @param args - 工具参数
 * @param ledgerDir - 账本目录
 * @returns { action, label, basis } 或 null
 */
function classify(toolName, args, ledgerDir) {
  const name = String(toolName || '');

  const script = scriptInCommand(commandTextOf(name, args));
  if (script !== null) return { action: script.action, label: script.label, basis: 'script-in-command' };

  const filePath = filePathOf(args);
  if (filePath.length > 0 && isInside(ledgerDir, filePath)) {
    if (baseNameOf(filePath) === EVIDENCE_NAME.toLowerCase()) return null;
    const isWrite = WRITE_TOOLS.indexOf(name) >= 0;
    return { action: isWrite ? 'record' : 'query', label: (isWrite ? '改账本文件（' : '读账本文件（') + name + '）', basis: 'file-path-in-ledger' };
  }

  if (name === 'skill' && isPlainObject(args) && String(args.name || '') === SKILL_NAME) {
    return { action: 'query', label: '加载 lesson-ledger 技能', basis: 'skill-name' };
  }

  const fallback = scriptInCommand(blobOf(args));
  if (fallback !== null) return { action: fallback.action, label: fallback.label, basis: 'script-in-args' };

  return null;
}

/** 超过这个时长没有新活动就不再算「未查询」（否则老会话会永久挂红）。 */
const STALE_ACTIVITY_MS = 30 * 60 * 1000;

/**
 * 按计数判定结论（合并后重算也用这个，保证口径一致）。
 * @param queries - 查询次数
 * @param records - 记录次数
 * @param active - 是否曾有过工具活动
 * @param ageMs - 距最后一次活动的毫秒数（null 表示没有活动）
 * @returns 结论标识
 */
function verdictFromCounts(queries, records, active, ageMs) {
  const hasQuery = queries > 0;
  const hasRecord = records > 0;
  if (hasQuery && hasRecord) return 'ok';
  if (hasQuery) return 'query-only';
  if (hasRecord) return 'record-no-query';
  if (active !== true || ageMs === null || ageMs > STALE_ACTIVITY_MS) return 'idle';
  return 'missing-query';
}
/** 会话体检结论。 */
function verdictOf(rec) {
  const ageMs = rec.activeAt === null ? null : Math.max(0, Date.now() - rec.lastAt);
  return verdictFromCounts(rec.queries, rec.records, rec.activeAt !== null, ageMs);
}
function isoOf(ms) { return ms === null || ms === undefined ? null : new Date(ms).toISOString(); }
function safeLedgerDir(configured) {
  const fallback = DEFAULT_LEDGER_DIR;
  if (typeof configured !== 'string' || configured.length === 0) return fallback;
  const looksAbsolute = /^[A-Za-z]:[\\/]/.test(configured) || configured.startsWith('\\\\');
  if (!looksAbsolute || configured.indexOf('..') >= 0) return fallback;
  return configured;
}

/**
 * 扫账本规则库：条目数、复发记录（规则失效待改）、修订记录（已自我修正）。
 * 这就是「自我升级是否成功」的指示灯 —— 复发多说明规则没生效，修订多说明改硬过。
 *
 * 实现上直接复用 recall.js 的 scanLedger：原来这里另有一份逐行扫描的副本，
 * 两份必须手工同步，结果漏改一处就静默少报（复测实测 DSH-1000 起全不认）。
 * 现在只有一份实现，scanLedgerStats 只做字段裁剪（剥掉 items 的正文，快照里不需要）。
 * @param ledgerDir - 账本目录
 * @returns 统计结果（失败时带 error，不抛）
 */
function scanLedgerStats(ledgerDir) {
  try {
    const { stats } = scanLedger(ledgerDir);
    return {
      entries: stats.entries,
      relapse: stats.relapse,
      revised: stats.revised,
      files: stats.files,
      recognized: stats.recognized,
      truncated: stats.truncated,
      recallPool: stats.recallPool,
      at: stats.at,
      error: stats.error
    };
  } catch (error) {
    return { entries: 0, relapse: 0, revised: 0, files: 0, at: Date.now(), error: sanitize((error && error.message) || error, MAX_NOTE_LEN) };
  }
}

/** 从工具结果里抽出可读文本（用于检测退出码）。 */
function resultText(result) {
  const out = [];
  try {
    if (typeof result === 'string') return result;
    if (!isPlainObject(result)) return '';
    for (const key of ['text', 'output', 'stdout', 'stderr']) {
      const value = result[key];
      if (typeof value === 'string' && value.length > 0) out.push(value);
    }
    if (Array.isArray(result.content)) {
      for (const block of result.content.slice(0, 8)) {
        if (isPlainObject(block) && typeof block.text === 'string') out.push(block.text);
      }
    }
  } catch (error) { /* 忽略 */ }
  return out.join('\n').slice(0, 20000);
}
/** 可疑事件：不是「坑」的判定，只是把可观测的信号标出来交给模型判断。 */
const CHURN_CALLS = 25;
/** 用户消息里出现这些词，视为「疑似纠正」——AGENTS.md 把「用户纠正」列为最该记的一类。 */
const CORRECTION_RE = /不对|不是这样|错了|搞错|别这样|不要再|又犯|还是不行|怎么又|你搞错|没按|漏了|忽略了|我说过|重新来|回退|撤回|undo|wrong|again|not what I|shouldn't/;

/**
 * 判定「用户疑似纠正」的标记词。
 * 验收实测：直接 exec 的误报率 52.5%（引用别人的话、疑问句都会被算成纠正），所以先做三步清洗：
 * ① 去掉 markdown 引用行与行内引用（「…」/“…”/`…`）② 去掉括注（全角/半角括号）—— 实测
 * 「（不是说你做错了）」「断言式纠正（不对，…）」这两类任务书误报靠它拦掉
 * ③ 疑问句与假设句不算纠正。
 * @param text - 用户消息文本
 * @returns 命中的标记词，或 null
 */
function correctionMarker(text) {
  const cleaned = String(text)
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/[「『"'`][^」』"'`]{0,80}[」』"'`]/g, ' ')
    // 括注剥离：全角 （） 与半角 () 成对出现时整段去掉。任务是「说明里顺带提到」，
    // 不是「在纠正我」——实测可拦掉 318 条真实消息里 2 条任务书误报。
    .replace(/（[^）]{0,120}）|\([^)]{0,120}\)/g, ' ');
  const marker = CORRECTION_RE.exec(cleaned);
  if (marker === null) return null;
  // 整段是疑问（有问号且没有断言式纠正）→ 视为在问，不是在纠正
  const assertive = /不对[，,。！!]|错了[，,。！!]|不要再|我说过|又犯|你搞错/.test(cleaned);
  if (/[？?]/.test(cleaned) && !assertive) return null;
  // 假设闸：「…的话，就…」是在说条件，不是在纠正（实测多拦 1 条：还是不行的话，就换方案 B）
  if (/的话[，,]/.test(cleaned) && !assertive) return null;
  return marker[0];
}

/** 从 user/message 事件里尽力取出用户文本（形状未知，多形状兜底）。 */
function userTextOf(event) {
  try {
    const candidates = [
      event && event.data && event.data.content,
      event && event.message && event.message.content,
      event && event.data && event.data.message && event.data.message.content,
      event && event.content
    ];
    for (const content of candidates) {
      if (!Array.isArray(content)) continue;
      const text = content
        .filter((block) => block !== null && block !== undefined && block.type === 'text')
        .map((block) => String(block.text || ''))
        .join('\n');
      if (text.length > 0) return text.slice(0, 4000);
    }
  } catch (error) { /* 取不到就当没有 */ }
  return '';
}

/** 五类信号求和。 */
function signalTotal(signals) {
  if (!isPlainObject(signals)) return 0;
  // churn 不计入触发（验收实测：真实会话上 calls≥25 且零记录几乎是必然，它是 records==0 的同义反复）；
  // 它只作为说明性标注出现在摘要里。
  return (signals.failures || 0) + (signals.retries || 0) + (signals.rewrites || 0) +
    (signals.corrections || 0);
}

/** 合并两个 signals（逐字段取 max，供证据文件合并用）。 */
function mergeSignals(a, b) {
  const out = { failures: 0, retries: 0, rewrites: 0, corrections: 0, churn: 0 };
  for (const key of Object.keys(out)) {
    out[key] = Math.max((a && a[key]) || 0, (b && b[key]) || 0);
  }
  return out;
}

/** 信号摘要（只列非零项，给界面直接显示）。 */
function signalSummary(signals) {
  if (!isPlainObject(signals)) return '';
  const parts = [];
  if (signals.failures > 0) parts.push('失败调用 ' + signals.failures + ' 次');
  if (signals.retries > 0) parts.push('重复调用 ' + signals.retries + ' 次');
  if (signals.rewrites > 0) parts.push('同一文件反复改 ' + signals.rewrites + ' 次');
  if (signals.corrections > 0) parts.push('用户疑似纠正 ' + signals.corrections + ' 次');
  if (signals.churn > 0) parts.push('大量工具调用但零记录');
  return parts.join(' · ');
}
/**
 * 判断一次工具调用是否失败。
 * 关键：本机 pwsh 工具把失败写在输出文本的 [exit code: N] 里（实测 isError 恒为 false），
 * 所以必须解析退出码，否则「命令跑失败了」这类最常见的踩坑根本收不到（验收 F2）。
 * 但**文本判据只对命令类工具生效**：read 一个含 `[exit code: 1]` 字面量的文件、
 * grep 匹配到该串的行，都会把成功调用误判成失败（复测实测真实占比 2.1%）。
 * @param result - 工具结果
 * @param toolName - 工具名；仅命令类（COMMAND_TOOLS）走文本判据
 * @returns 是否失败
 */
function isFailure(result, toolName) {
  if (!isPlainObject(result)) return false;
  if (result.ok === false) return true;
  if (result.isError === true) return true;
  if (result.error !== undefined && result.error !== null) return true;
  for (const key of ['exitCode', 'exit_code', 'code', 'status']) {
    const value = result[key];
    if (typeof value === 'number' && value !== 0) return true;
  }
  // 文本判据仅限命令类工具：只有它们结果里的 [exit code: N] 才是真退出码
  if (COMMAND_TOOLS[String(toolName || '')] === undefined) return false;
  const match = /\[exit code:\s*(-?\d+)\]/i.exec(resultText(result));
  if (match !== null && Number(match[1]) !== 0) return true;
  return false;
}

/** 账本监视器 Remote 服务。 */
class LedgerWatchGateway extends TypertRemoteService {
  constructor(ctx, config) {
    super(ctx, 'ledgerWatch');
    this.ownCtx = ctx;
    this.config = isPlainObject(config) ? config : {};
    this.ledgerDir = safeLedgerDir(this.config.ledgerDir);
    this.evidencePath = join(this.ledgerDir, EVIDENCE_NAME);
    this.exposeEvidence = this.config.exposeEvidence === true;
    // 默认 off：高置信模式在 holdout 复测通过前不默认开启（见 DECISION-2026-10-27-auto-recall-mode.md §5）
    this.recallMode = this.config.recallMode === 'high-confidence' ? 'high-confidence' : 'off';

    this.sessions = new Map();
    this.order = [];
    this.diag = [];
    this.observed = 0;
    this.lastTool = null;
    this.clientSeen = null;
    this.lastReportAt = 0;
    this.reportThrottled = 0;
    this.writeFailures = 0;
    this.lastWriteError = null;
    this.lastWriteAt = null;
    this.subscribed = { tools: false, session: false };
    this.writeTimer = null;
    const bootScan = scanLedger(this.ledgerDir);
    this.ledger = bootScan.stats;
    this.ledgerItems = bootScan.items;
    this.ledgerTimer = null;
    this.resultShapeLogged = false;
    // 召回：按会话记住上次注入的条目签名，同一批不重复注入
    this.recalls = 0;
    this.recallSkipped = 0;
    this.lastRecallIds = null;
    this.lastRecall = new Map();
    this.recallBudget = new Map();
    this.recallSeen = new Map();
    this.recallPending = new Map();
    this.recallCitedIds = 0;   // 被引用的条目 ID 数（推断值，不是「采纳」）
    this.sessionInferred = 0;
    this.recallHistory = [];

    this.attach();
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        if (this.writeTimer !== null) { clearTimeout(this.writeTimer); this.writeTimer = null; }
        if (this.ledgerTimer !== null) { clearTimeout(this.ledgerTimer); this.ledgerTimer = null; }
      });
      ctx.effect(() => {
        const tick = () => {
          const scan = scanLedger(this.ledgerDir);
          this.ledger = scan.stats;
          this.ledgerItems = scan.items;
          this.ledgerTimer = setTimeout(tick, LEDGER_SCAN_INTERVAL_MS);
        };
        this.ledgerTimer = setTimeout(tick, LEDGER_SCAN_INTERVAL_MS);
        return () => { if (this.ledgerTimer !== null) { clearTimeout(this.ledgerTimer); this.ledgerTimer = null; } };
      }, 'ledger-watch: ledger scan timer');
    }
    this.note('已启动，build=' + BUILD + '，账本目录 = ' + this.ledgerDir +
      '，规则库 ' + this.ledger.entries + ' 条（复发 ' + this.ledger.relapse + ' / 修订 ' + this.ledger.revised + '）');
    this.scheduleWrite(true);
  }

  note(message) {
    try {
      const line = new Date().toISOString().slice(11, 19) + ' ' + sanitize(message, MAX_NOTE_LEN);
      this.diag.unshift(line);
      while (this.diag.length > MAX_DIAG) this.diag.pop();
    } catch (error) { /* 诊断失败不影响主流程 */ }
  }

  attach() {
    try {
      this.ownCtx.on('tools/result', (exec, result) => {
        try { this.onToolResult(exec, result); } catch (error) { this.note('onToolResult 抛错：' + String((error && error.message) || error)); }
      });
      this.subscribed.tools = true;
      this.note('已订阅 tools/result');
    } catch (error) { this.note('订阅 tools/result 失败：' + String((error && error.message) || error)); }
    try {
      this.ownCtx.on('session/event', (session, event) => {
        try { this.onSessionEvent(session, event); } catch (error) { this.note('onSessionEvent 抛错：' + String((error && error.message) || error)); }
      });
      this.subscribed.session = true;
      this.note('已订阅 session/event');
    } catch (error) { this.note('订阅 session/event 失败：' + String((error && error.message) || error)); }
    try {
      this.ownCtx.on('agent/pre-step', async (payload, next) => {
        const decision = await next();
        try { return this.injectRecall(payload, decision); } catch (error) {
          this.note('召回注入失败：' + String((error && error.message) || error));
          return decision;
        }
      });
      this.subscribed.recall = true;
      this.note('已订阅 agent/pre-step（按任务召回）');
    } catch (error) { this.note('订阅 agent/pre-step 失败：' + String((error && error.message) || error)); }
  }

  /**
   * 按当前任务召回账本规则并注入本次 step 的消息流。
   * 只在每轮第 1 步注入；同一批条目在同一会话不重复注入。
   * @param payload - agent/pre-step 载荷 { agent, messages, step, signal }
   * @param decision - 下游决策对象
   * @returns 可能插入了召回消息的 decision
   */
  injectRecall(payload, decision) {
    const agent = payload === undefined || payload === null ? undefined : payload.agent;
    const messages = payload === undefined || payload === null ? undefined : payload.messages;
    const step = payload === undefined || payload === null ? undefined : payload.step;
    if (agent === undefined || agent === null || !Array.isArray(messages) || step !== 1) return decision;
    if (decision === undefined || decision === null || !Array.isArray(decision.messages)) return decision;
    // 与宿主 dsh-agent-instructions 同策略：第 1 步但决策里没有任何消息时不注入
    if (decision.messages.length === 0) return decision;
    if (this.ledgerItems.length === 0) return decision;

    let taskText = '';
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message === undefined || message === null || message.role !== 'user' || !Array.isArray(message.content)) continue;
      taskText = message.content
        .filter((block) => block !== null && block !== undefined && block.type === 'text')
        .map((block) => String(block.text || ''))
        .join('\n');
      if (taskText.length > 0) break;
    }
    if (taskText.length < 4) return decision;

    const hits = this.recallMode === 'off' ? [] : recallFor(taskText, this.ledgerItems, 4);
    if (hits.length === 0) return decision;
    const sessionId = agent.session === undefined || agent.session === null ? 'unknown' : String(agent.session.id);
    if (this.lastRecall.get(sessionId) === hits.map((hit) => hit.id).join(',')) return decision;

    // 按条目去重：本会话已经召回过的条目不再重复投递（原来靠「4 元组签名」，同一批里换一条就重发）
    const seen = this.recallSeen.get(sessionId) || new Set();
    const fresh = hits.filter((hit) => !seen.has(hit.id));
    if (fresh.length === 0) {
      this.recallSkipped += 1;
      this.note('本会话这些条目已召回过，跳过（' + sessionId.slice(0, 22) + '）');
      return decision;
    }

    const used = this.recallBudget.get(sessionId) || 0;
    let recallText = buildRecallText(fresh, this.ledgerDir);
    let delivered = fresh;
    if (used + recallText.length > RECALL_SESSION_BUDGET) {
      // 预算紧张时降级为只投最相关的一条（而不是整段停掉，那样长会话后半段等于关掉召回）
      delivered = fresh.slice(0, 1);
      recallText = buildRecallText(delivered, this.ledgerDir);
      if (used + recallText.length > RECALL_SESSION_BUDGET) {
        this.recallSkipped += 1;
        this.note('本会话召回预算已用尽（' + used + '/' + RECALL_SESSION_BUDGET + '），跳过');
        return decision;
      }
    }
    const signature = delivered.map((hit) => hit.id).join(',');
    for (const hit of delivered) seen.add(hit.id);
    this.recallSeen.set(sessionId, seen);
    this.lastRecall.set(sessionId, signature);   // 写投递签名，与上面的比较口径一致
    this.recalls += 1;
    this.lastRecallIds = signature;
    this.recallBudget.set(sessionId, used + recallText.length);
    const rec = this.sessions.get(sessionId);
    this.recallHistory.unshift({ at: isoOf(Date.now()), sessionId: sessionId.slice(0, 24), turn: rec === undefined ? null : rec.turns, ids: signature, chars: recallText.length });
    // 待采纳队列：后续工具调用若引用了这些 ID，就算「召回了并被采用」（可核的采纳信号）
    this.recallPending.set(sessionId, delivered.map((hit) => hit.id));
    while (this.recallHistory.length > 10) this.recallHistory.pop();
    // 会话表淘汰：两个 Map 无上限会随会话数增长（验收实测 40 会话 → size 41）
    if (this.lastRecall.size > 64) {
      const oldest = this.lastRecall.keys().next().value;
      this.lastRecall.delete(oldest);
      this.recallBudget.delete(oldest);
      this.recallSeen.delete(oldest);
      this.recallPending.delete(oldest);
    }
    const message = createUserMessage({
      content: [{ type: 'text', text: recallText }],
      source: { kind: 'ledger-watch', form: 'notice', summary: '经验召回 ' + delivered.length + ' 条：' + signature }
    });
    const lastClaimed = decision.messages.findLastIndex((item) => messages.indexOf(item) >= 0);
    const entered = lastClaimed >= 0
      ? decision.messages.toSpliced(lastClaimed + 1, 0, message)
      : decision.messages.concat([message]);
    this.note('已召回 ' + signature + '（会话 ' + sessionId.slice(0, 22) + '）');
    // 这里保留同步写：证据文件的即时可见性优先（实测单次 4–10ms、每轮仅一次，
    // 而「召回了什么」必须马上能从 .watch.json 核到；真正需要挪走的是长退避，已挪）。
    this.scheduleWrite(true);
    return { ...decision, messages: entered };
  }

  recOf(id) {
    const key = typeof id === 'string' && id.length > 0 ? id : 'unknown';
    let rec = this.sessions.get(key);
    if (rec === undefined) {
      rec = {
        id: key, firstSeenAt: Date.now(), lastAt: Date.now(),
        queries: 0, records: 0, touches: 0, turns: 0, calls: 0, failures: 0,
        // 可疑事件（不判断是不是坑，只标出来）：失败调用 / 重复调用 / 同一文件反复改 / 用户疑似纠正 / 大量调用但零记录
        signals: { failures: 0, retries: 0, rewrites: 0, corrections: 0, churn: 0 },
        writeCounts: new Map(), lastCallKey: null,
        activeAt: null, turnStartedAt: null, lastLabel: null, lastAction: null, events: []
      };
      this.sessions.set(key, rec);
      this.order.push(key);
      while (this.order.length > MAX_SESSIONS) {
        const dropped = this.order.shift();
        this.sessions.delete(dropped);
      }
    }
    return rec;
  }

  sessionIdOf(exec) {
    try {
      const id = exec && exec.agent && exec.agent.session ? exec.agent.session.id : undefined;
      if (typeof id === 'string' && id.length > 0) return id;
    } catch (error) { /* 退化 */ }
    // R7：拿不到 exec.agent.session.id 时只能退化到「最近一次 session/event 的会话」，
    // 多会话并发时会误归属 —— 至少要让它可观测，而不是静默张冠李戴。
    this.sessionInferred += 1;
    if (this.sessionInferred === 1 || this.sessionInferred % 20 === 0) {
      this.note('会话归属退化到最近活跃会话（第 ' + this.sessionInferred + ' 次）');
    }
    return this.lastSessionId === undefined ? 'unknown' : this.lastSessionId;
  }

  onToolResult(exec, result) {
    this.observed++;
    const toolName = String((exec && exec.name) || '?');
    this.lastTool = toolName;
    const sid = this.sessionIdOf(exec);
    const rec = this.recOf(sid);
    rec.lastAt = Date.now();
    rec.calls++;
    if (rec.activeAt === null) rec.activeAt = rec.lastAt;

    const failed = isFailure(result, toolName);
    if (failed) { rec.failures++; rec.signals.failures += 1; }

    // ---- 可疑事件采集（全部只做可观测的计数，不做语义判断）----
    // ① 重试：连续两次「同一工具 + 同一参数」
    // 写类工具不算「重复调用」：blobOf 不含正文，同一文件写三次会得到同一个 key（假阳性）；
    // 写操作的重复已由下面的「反复改同一个文件」单独覆盖。
    if (WRITE_TOOLS.indexOf(toolName) < 0) {
      const callKey = toolName + '|' + blobOf(exec && exec.arguments);   // 不截断：截断会让长命令尾部的改动看不出来（S11）
      if (rec.lastCallKey !== null && rec.lastCallKey === callKey) rec.signals.retries += 1;
      rec.lastCallKey = callKey;
    } else {
      rec.lastCallKey = null;   // 写操作打断「连续两次」的连续性（S9）
    }
    // ② 反复改同一个文件：第 3 次起每次记一次
    if (WRITE_TOOLS.indexOf(toolName) >= 0) {
      const target = normPath(filePathOf(exec && exec.arguments));   // 必须归一化分隔符，否则 \ 与 / 交替写法绕过（S15）
      if (target.length > 0) {
        if (rec.writeCounts.size > 50) rec.writeCounts.clear();   // 兜底上限
        const times = (rec.writeCounts.get(target) || 0) + 1;
        rec.writeCounts.set(target, times);
        if (times >= 3) rec.signals.rewrites += 1;
      }
    }
    // ③ 空转：干了很多活却一条坑都没记（calls 到了阈值仍是零记录）
    if (rec.calls >= CHURN_CALLS && rec.records === 0) rec.signals.churn = 1;

    if (!this.resultShapeLogged) {
      this.resultShapeLogged = true;
      this.note('result 形状采样：' + (isPlainObject(result) ? Object.keys(result).slice(0, 8).join(',') : typeof result) + ' → failed=' + failed);
    }

    // 采纳信号：本轮召回过的条目 ID 若出现在这次调用的参数里，说明模型真的去用了
    try {
      const pending = this.recallPending.get(sid);
      if (pending !== undefined && pending.length > 0) {
        const argsText = blobOf(exec && exec.arguments).toLowerCase();
        const adopted = pending.filter((id) => argsText.indexOf(id.toLowerCase()) >= 0);
        if (adopted.length > 0) {
          this.recallCitedIds += adopted.length;
          this.recallPending.set(sid, pending.filter((id) => adopted.indexOf(id) < 0));
          this.note('召回被采用：' + adopted.join(',') + '（会话 ' + sid.slice(0, 22) + '）');
        }
      }
    } catch (error) { /* 采纳统计失败不影响主流程 */ }

    const hit = classify(toolName, exec && exec.arguments, this.ledgerDir);
    if (hit === null) { this.scheduleWrite(); return; }

    if (failed) {
      // 失败的账本调用没有产出任何信息，不能算「查过/记过」——只记事件
      rec.events.unshift({ at: Date.now(), action: hit.action, label: hit.label + '（失败，不计）', tool: toolName, basis: hit.basis, failed: true });
      while (rec.events.length > MAX_EVENTS_PER_SESSION) rec.events.pop();
      this.note('命中但失败 ' + hit.label + '（不计入查询/记录，会话 ' + sid.slice(0, 22) + '）');
      this.scheduleWrite(true);
      return;
    }

    if (hit.action === 'record') rec.records++;
    else if (hit.action === 'query') rec.queries++;
    else rec.touches++;
    rec.lastLabel = hit.label;
    rec.lastAction = hit.action;
    rec.events.unshift({ at: Date.now(), action: hit.action, label: hit.label, tool: toolName, basis: hit.basis });
    while (rec.events.length > MAX_EVENTS_PER_SESSION) rec.events.pop();
    this.note('命中 ' + hit.action + ' ' + hit.label + '（' + hit.basis + '，会话 ' + sid.slice(0, 22) + '）');
    this.scheduleWrite(true);
  }

  onSessionEvent(session, event) {
    const sid = session && session.id !== undefined ? String(session.id) : 'unknown';
    this.lastSessionId = sid;
    const rec = this.recOf(sid);
    const type = event && event.type !== undefined ? String(event.type) : '';
    rec.lastAt = Date.now();
    const probe = type.length > 0
      ? 'session event: ' + type
      : 'session event keys: ' + (isPlainObject(event) ? Object.keys(event).slice(0, 8).join(',') : typeof event);
    if (this.lastEventNote !== probe) {
      this.lastEventNote = probe;
      this.note(probe);
      this.scheduleWrite(true);
    }
    if (type === 'turn/start') {
      rec.turns++;
      rec.turnStartedAt = rec.lastAt;
      if (rec.activeAt === null) rec.activeAt = rec.lastAt;
      this.scheduleWrite(true);
    }
    // ④ 用户疑似纠正：只匹配标记词，不保存用户原文（隐私）
    if (type === 'user/message') {
      const text = userTextOf(event);
      const marker = text.length > 0 ? correctionMarker(text) : null;
      if (marker !== null) {
        rec.signals.corrections += 1;
        // marker 是字符串（correctionMarker 返回标记词本身），不是 exec 的 match 数组 —— 取 [0] 只会落 1 个字符
        this.note('用户疑似纠正（标记词：' + sanitize(marker, 20) + '，会话 ' + sid.slice(0, 22) + '）');
      }
      this.scheduleWrite(true);
    }
  }

  scheduleWrite(force) {
    try {
      if (force === true) {
        if (this.writeTimer !== null) { clearTimeout(this.writeTimer); this.writeTimer = null; }
        this.writeEvidence();
        return;
      }
      if (this.writeTimer !== null) return;
      this.writeTimer = setTimeout(() => {
        this.writeTimer = null;
        this.writeEvidence();
      }, WRITE_THROTTLE_MS);
    } catch (error) { this.note('调度写盘失败：' + String((error && error.message) || error)); }
  }

  /** 读回现有证据文件里的会话统计，用于合并（多实例/重启不互相清空）。 */
  readPreviousSessions() {
    try {
      if (!existsSync(this.evidencePath)) return [];
      const parsed = JSON.parse(readFileSync(this.evidencePath, 'utf8'));
      const list = Array.isArray(parsed.sessions) ? parsed.sessions : [];
      return list.filter((s) => isPlainObject(s) && typeof s.id === 'string');
    } catch (error) { return []; }
  }

  /**
   * 把「本进程观测到的会话」与「证据文件里的历史会话」合并成一份列表。
   *
   * 为什么**读路径也必须合并**（2026-10-28 活体实测，用户报告「每个会话看到的避坑核对
   * 好像都是一样的内容」）：`state()` 原来只遍历内存 `this.order`，而内存里只有
   * **本进程启动之后**观测到的会话。于是任何「重启前活跃」或「本进程没观测到」的会话，
   * `current` 恒为 null → 客户端渲染成「本会话还没开始」+ 同一份「其它会话」列表。
   * 实测：证据文件里 10 条、内存里 8 条，2 条只在文件里；侧栏可见的 6 个会话里，
   * 5 个的 sessionId 都不在内存中，面板全部显示同一份内容。
   * 写路径（writeEvidence）早就做了这个合并，读路径漏了 —— 一份事实两处实现又分叉。
   *
   * @param list - 本进程观测到的会话（snapshot 形状）
   * @returns 合并后按 lastAt 降序、派生字段已重算的列表
   */
  mergeWithPrevious(list) {
    const merged = new Map();
    for (const s of this.readPreviousSessions()) merged.set(s.id, s);
    for (const s of list) {
      const old = merged.get(s.id);
      if (old === undefined) { merged.set(s.id, s); continue; }
      merged.set(s.id, {
        ...s,
        queries: Math.max(old.queries || 0, s.queries || 0),
        records: Math.max(old.records || 0, s.records || 0),
        turns: Math.max(old.turns || 0, s.turns || 0),
        calls: Math.max(old.calls || 0, s.calls || 0),
        // 标量 failures 与 signals.failures 不得分叉（signals-v2 复测必修 3）
        failures: Math.max(old.failures || 0, s.failures || 0,
          (old.signals && old.signals.failures) || 0, (s.signals && s.signals.failures) || 0),
        // S31：signals 必须像标量那样逐字段取 max，否则多实例/重启后计数回退
        signals: mergeSignals(old.signals, s.signals),
        // 事件明细取信息更多的一侧（内存里是本进程新采的，优先）
        events: (Array.isArray(s.events) && s.events.length > 0 ? s.events : (Array.isArray(old.events) ? old.events : [])).slice(0, 12),
        lastLabel: s.lastLabel !== undefined && s.lastLabel !== null ? s.lastLabel : (old.lastLabel ?? null),
        lastAction: s.lastAction !== undefined && s.lastAction !== null ? s.lastAction : (old.lastAction ?? null),
        firstSeenAt: old.firstSeenAt && s.firstSeenAt ? (old.firstSeenAt < s.firstSeenAt ? old.firstSeenAt : s.firstSeenAt) : (old.firstSeenAt || s.firstSeenAt),
        lastAt: old.lastAt && s.lastAt ? (old.lastAt > s.lastAt ? old.lastAt : s.lastAt) : (old.lastAt || s.lastAt)
      });
    }
    return [...merged.values()]
      .map((s) => ({
        ...s,
        // 派生字段必须按合并后的计数重算（不能沿用任一侧的旧值）
        failures: Math.max(s.failures || 0, (s.signals && s.signals.failures) || 0),
        enabled: (s.queries || 0) > 0,
        verdict: verdictFromCounts(s.queries || 0, s.records || 0, s.lastAt !== undefined && s.lastAt !== null,
          s.lastAt === undefined || s.lastAt === null ? null : Math.max(0, Date.now() - Date.parse(s.lastAt))),
        needRecordSignals: (s.records || 0) === 0 ? signalSummary(s.signals) : null,
        needRecord: (s.records || 0) === 0 && signalTotal(s.signals) > 0
      }))
      .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
  }

  writeEvidence() {
    try {
      // snapshot() 现在已经在读路径上做了「内存 ∪ 证据文件」的合并并重算派生字段，
      // 这里不再重复一份手写合并逻辑 —— 一份事实两处实现必然分叉（2026-10-28：读路径漏合并）。
      const payload = this.snapshot(null, true);
      payload.sessions = payload.sessions.slice(0, 10);
      // current 由 snapshot 按合并后的列表给出，且必然是 lastAt 最大的那条，一定落在上面 10 条内
      const text = JSON.stringify(payload, null, 2);
      mkdirSync(this.ledgerDir, { recursive: true });
      const tmp = this.evidencePath + '.tmp-' + String(process.pid);
      writeFileSync(tmp, text, 'utf8');
      // Windows 上 rename 会被并发读者挡住（EPERM/EACCES/EBUSY）→ 退避重试
      // 退避必须短：这段可能跑在 agent/pre-step 同步路径上，实测 8 次忙等累计阻塞事件循环 1277.6ms。
      // 现在最多 3 次、合计 ≤7ms，之后降级为直接写（原子优先，但不允许阻塞调用路径）。
      // 立即重试（不睡）：这段可能跑在 agent/pre-step 同步路径上，绝不能用长退避阻塞事件循环
      // （实测 8 次忙等累计阻塞 1277.6ms）。Windows 上 rename 失败是读者持有句柄的瞬态冲突，
      // 密集重试命中释放间隙的成功率远高于长退避。
      let lastError = null;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          renameSync(tmp, this.evidencePath);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          const code = error && error.code;
          if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') break;
        }
      }
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch (error) { /* tmp 清理失败不影响结果 */ }
      if (lastError !== null) {
        // 只做原子替换：宁可不更新（读者拿到的是旧内容，仍是完整 JSON），也不写出半截文件。
        // 计数 + 稍后自动重试；调用方（含 agent/pre-step 同步路径）不会被长退避阻塞。
        this.writeFailures += 1;
        this.lastWriteError = sanitize('原子替换失败（读者占用中）：' + String((lastError && lastError.code) || lastError.message), MAX_NOTE_LEN);
        this.note('写证据文件跳过（累计 ' + this.writeFailures + '）：' + this.lastWriteError);
        this.scheduleWrite();
        return;
      }
      this.lastWriteAt = Date.now();
      this.lastWriteError = null;
    } catch (error) {
      this.writeFailures++;
      this.lastWriteError = sanitize((error && error.message) || error, MAX_NOTE_LEN);
      this.note('写证据文件失败（累计 ' + this.writeFailures + '）：' + this.lastWriteError);
    }
  }

  snapshot(sessionId, internal) {
    const list = [];
    for (const key of this.order) {
      const rec = this.sessions.get(key);
      if (rec === undefined) continue;
      const verdict = verdictOf(rec);
      list.push({
        id: rec.id,
        firstSeenAt: isoOf(rec.firstSeenAt),
        lastAt: isoOf(rec.lastAt),
        queries: rec.queries,
        records: rec.records,
        turns: rec.turns,
        calls: rec.calls,
        failures: Math.max(rec.failures, rec.signals.failures || 0),
        lastLabel: rec.lastLabel,
        lastAction: rec.lastAction,
        verdict: verdict,
        // 用户口径：本会话「有没有启用避坑/提升功能」= 有没有查过账本
        enabled: rec.queries > 0,
        // 推动用：本会话出现过「可疑事件」却一条没记 → 收尾必须补记
        // 注意：可疑事件 ≠ 坑。它只是把五类可观测信号标出来，判断权仍在模型（见 README）
        signals: { ...rec.signals },
        needRecordSignals: rec.records === 0 ? signalSummary(rec.signals) : null,
        needRecord: rec.records === 0 && signalTotal(rec.signals) > 0,
        events: rec.events.slice(0, 12).map((e) => ({ at: isoOf(e.at), action: e.action, label: e.label, tool: e.tool, basis: e.basis }))
      });
    }
    // 读路径必须与写路径用同一份合并：内存里只有「本进程启动后」观测到的会话，
    // 只遍历 this.order 会让重启前活跃的会话 current 恒为 null（见 mergeWithPrevious 注释）。
    const recent = this.mergeWithPrevious(list);
    let current = null;
    let known = false;   // 请求的会话是否在本插件已知范围内（内存 ∪ 证据文件）
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      current = recent.find((r) => r.id === sessionId) ?? null;
      known = current !== null;
    } else {
      // 没有会话 id 时**绝不能**顶替成「最近活跃会话」：面板上「本会话」三个字是最强的承诺，
      // 拿别的会话的数字顶上就是明确说错人（2026-10-28 评审 P0）。宁可如实回答「不在监视范围」，
      // 让界面把原因讲清楚（client 的 unobserved 分支），也不要给一个自信的错答案。
      current = null;
      known = false;
    }
    const totals = { sessions: recent.length, queries: 0, records: 0, observedToolCalls: this.observed };
    for (const item of recent) {
      totals.queries += item.queries;
      totals.records += item.records;
    }
    const out = {
      updatedAt: new Date().toISOString(),
      build: BUILD,
      // 该会话是否被本插件观测过。false 表示「插件从没见过它」——与「见过但还没活动」是两回事，
      // 界面必须能分开说，否则会把「没观测到」说成「本会话还没开始」（用户误以为所有会话内容一样）。
      sessionKnown: known,
      trackedSessions: recent.length,
      ledgerDir: this.ledgerDir,
      evidencePath: this.evidencePath,
      subscribed: { tools: this.subscribed.tools, session: this.subscribed.session },
      observedToolCalls: this.observed,
      lastTool: this.lastTool,
      writeFailures: this.writeFailures,
      lastWriteError: this.lastWriteError,
      lastWriteAt: isoOf(this.lastWriteAt),
      reportThrottled: this.reportThrottled,
      recalls: this.recalls,
      recallSkipped: this.recallSkipped,
      lastRecallIds: this.lastRecallIds,
      recallEntries: this.ledgerItems.length,
      recallHistory: this.recallHistory,
      recallCitedIds: this.recallCitedIds,
      sessionInferred: this.sessionInferred,
      recallPending: this.recallPending.size,
      // 截断必须可见：只做到 lib 层、到不了界面，等于这一半没做完（复测：运行中的 .watch.json 无这三字段）
      ledger: {
        entries: this.ledger.entries,
        relapse: this.ledger.relapse,
        revised: this.ledger.revised,
        files: this.ledger.files,
        recognized: this.ledger.recognized === undefined ? this.ledger.entries : this.ledger.recognized,
        truncated: this.ledger.truncated === true,
        recallPool: this.ledger.recallPool === undefined ? null : this.ledger.recallPool,
        at: isoOf(this.ledger.at),
        error: this.ledger.error,
        // 冷启动引导（产品评审 2026-10-28）：界面必须能分开说三件事，否则陌生人的第一屏
        // 是一根指认他做错事的红条 + 「规则库 0 条」，页面上没有任何一个按钮能修好它。
        //   missing : 账本技能没装（lessons/ 与 workspaces/ 都不存在）→ 该出引导卡，不出红条
        //   empty   : 技能在、但一条规则都没有           → 引导卡
        //   ready   : 有规则可查                        → 正常态
        status: this.ledger.status,
        dir: this.ledgerDir
      },
      // 召回必须常显：默认关闭时原来那一行根本不渲染，用户不知道世界上有这个功能（产品评审 2026-10-28）
      recall: {
        mode: this.recallMode,
        enabled: this.recallMode !== 'off',
        entries: this.ledgerItems.length,
        configKey: 'recallMode',
        configValue: this.recallMode
      },
      client: this.clientSeen,
      totals,
      current,
      sessions: recent.slice(0, 10)
    };
    if (internal === true) {
      out.diag = this.diag.slice(0, 14);
      out.heartbeatAt = isoOf(Date.now());
    }
    return out;
  }

  /**
   * Remote：读当前状态。参数必须扁平声明（typert 网关按签名校验字段名，见 DSH-012）。
   * @param sessionId - 会话 id；空串取最近活跃
   * @returns 状态快照
   */
  async state(sessionId) {
    const id = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId.slice(0, 128) : null;
    return this.snapshot(id, false);
  }

  /**
   * Remote：读证据文件原文。默认关闭（客户端从未调用，属冗余读通道）。
   * @returns 内容或拒绝说明
   */
  async evidence() {
    if (!this.exposeEvidence) return { ok: false, note: 'evidence() 已默认关闭（config.exposeEvidence !== true）', path: this.evidencePath };
    try {
      if (!existsSync(this.evidencePath)) return { ok: false, note: '证据文件尚未生成', path: this.evidencePath };
      return { ok: true, path: this.evidencePath, text: readFileSync(this.evidencePath, 'utf8').slice(0, 200000) };
    } catch (error) {
      return { ok: false, note: sanitize((error && error.message) || error, MAX_NOTE_LEN), path: this.evidencePath };
    }
  }

  /**
   * Remote：客户端回报自己。限类型、限长、限速、清洗。
   * @param clientBuild - 客户端 build 串
   * @param note - 注册结果或错误摘要
   * @returns 确认
   */
  async report(clientBuild, note) {
    if (typeof clientBuild !== 'string' || typeof note !== 'string') {
      return { ok: false, note: 'clientBuild 与 note 必须是字符串' };
    }
    const now = Date.now();
    if (now - this.lastReportAt < REPORT_MIN_INTERVAL_MS) {
      this.reportThrottled++;
      return { ok: false, note: '限速中（间隔 ' + REPORT_MIN_INTERVAL_MS + 'ms）' };
    }
    this.lastReportAt = now;
    const build = sanitize(clientBuild, MAX_CLIENT_BUILD);
    const text = sanitize(note, MAX_CLIENT_NOTE);
    const previous = this.clientSeen;
    this.clientSeen = { build: build, note: text, at: isoOf(now), reports: previous === null ? 1 : previous.reports + 1 };
    if (previous === null || previous.build !== build) {
      this.note('客户端回报 build=' + build + ' · ' + text);
      this.scheduleWrite(true);
    }
    return { ok: true, at: isoOf(now) };
  }
}

Object.defineProperty(LedgerWatchGateway.prototype, REMOTE_METHOD_DESCRIPTOR, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze(
      ['state', 'evidence', 'report'].map((method) =>
        Object.freeze({ method, invocation: Object.freeze({ kind: 'direct' }) })
      )
    )
  })
});

export { LedgerWatchGateway, classify, verdictOf, sanitize, scanLedgerStats };
export default LedgerWatchGateway;
