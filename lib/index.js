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
import { writeFileSync, readFileSync, mkdirSync, existsSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
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
const BUILD = '2026-10-27 12:20 +08 · recall-v3-hiconf';

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
const ENTRY_RE = /^##\s+((?:ENV|DSH|DATA|PRC|WS-[A-Z0-9]+)-\d{3})\s+/;
const RELAPSE_MARK = '复发记录';
const REVISION_MARK = '修订记录';

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
 * @param ledgerDir - 账本目录
 * @returns 统计结果（失败时带 error，不抛）
 */
function scanLedgerStats(ledgerDir) {
  const out = { entries: 0, relapse: 0, revised: 0, files: 0, at: Date.now(), error: null };
  try {
    // 全局层 lessons/ + 工作区层 workspaces/ 都要扫（漏掉后者会少报约四分之一）
    let scanned = 0;
    for (const sub of ['lessons', 'workspaces']) {
      const dir = join(ledgerDir, sub);
      if (!existsSync(dir)) continue;
      scanned++;
      for (const name of readdirSync(dir)) {
        if (!name.toLowerCase().endsWith('.md')) continue;
        if (name.startsWith('_') || name === 'WORKSPACES.md') continue;
        let text;
        try { text = readFileSync(join(dir, name), 'utf8'); } catch (error) { continue; }
        out.files++;
        for (const line of text.split(/\r?\n/)) {
          if (ENTRY_RE.test(line)) out.entries++;
          else if (line.indexOf(RELAPSE_MARK) >= 0) out.relapse++;
          else if (line.indexOf(REVISION_MARK) >= 0) out.revised++;
        }
      }
    }
    if (scanned === 0) out.error = 'lessons/ 与 workspaces/ 都不存在';
  } catch (error) {
    out.error = sanitize((error && error.message) || error, MAX_NOTE_LEN);
  }
  return out;
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
/**
 * 判断一次工具调用是否失败。
 * 关键：本机 pwsh 工具把失败写在输出文本的 [exit code: N] 里（实测 isError 恒为 false），
 * 所以必须解析退出码，否则「命令跑失败了」这类最常见的踩坑根本收不到（验收 F2）。
 * @param result - 工具结果
 * @returns 是否失败
 */
function isFailure(result) {
  if (!isPlainObject(result)) return false;
  if (result.ok === false) return true;
  if (result.isError === true) return true;
  if (result.error !== undefined && result.error !== null) return true;
  for (const key of ['exitCode', 'exit_code', 'code', 'status']) {
    const value = result[key];
    if (typeof value === 'number' && value !== 0) return true;
  }
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

    const failed = isFailure(result);
    if (failed) rec.failures++;
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

  writeEvidence() {
    try {
      const payload = this.snapshot(null, true);
      // 合并：同一会话取更大的计数；本进程没有的会话保留（重启后历史不丢）
      const merged = new Map();
      for (const s of this.readPreviousSessions()) merged.set(s.id, s);
      for (const s of payload.sessions) {
        const old = merged.get(s.id);
        if (old === undefined) { merged.set(s.id, s); continue; }
        merged.set(s.id, {
          ...s,
          queries: Math.max(old.queries || 0, s.queries || 0),
          records: Math.max(old.records || 0, s.records || 0),
          turns: Math.max(old.turns || 0, s.turns || 0),
          calls: Math.max(old.calls || 0, s.calls || 0),
          failures: Math.max(old.failures || 0, s.failures || 0),
          firstSeenAt: old.firstSeenAt && s.firstSeenAt ? (old.firstSeenAt < s.firstSeenAt ? old.firstSeenAt : s.firstSeenAt) : (old.firstSeenAt || s.firstSeenAt),
          lastAt: old.lastAt && s.lastAt ? (old.lastAt > s.lastAt ? old.lastAt : s.lastAt) : (old.lastAt || s.lastAt)
        });
      }
      const mergedList = [...merged.values()]
        .map((s) => ({
          ...s,
          // 派生字段必须按合并后的计数重算
          enabled: (s.queries || 0) > 0,
          verdict: verdictFromCounts(s.queries || 0, s.records || 0, s.lastAt !== undefined && s.lastAt !== null,
            s.lastAt === undefined || s.lastAt === null ? null : Math.max(0, Date.now() - Date.parse(s.lastAt))),
          needRecord: (s.failures || 0) > 0 && (s.records || 0) === 0
        }))
        .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
      payload.sessions = mergedList.slice(0, 10);
      payload.totals = { ...payload.totals, sessions: mergedList.length };
      // current 也要取合并后的那一条（否则与 sessions[] 不一致）
      const wantedId = payload.current === null ? null : payload.current.id;
      payload.current = (wantedId === null ? null : mergedList.find((s) => s.id === wantedId)) || mergedList[0] || null;

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
        failures: rec.failures,
        lastLabel: rec.lastLabel,
        lastAction: rec.lastAction,
        verdict: verdict,
        // 用户口径：本会话「有没有启用避坑/提升功能」= 有没有查过账本
        enabled: rec.queries > 0,
        // 推动用：本会话踩过坑（有失败调用）却一条没记 → 收尾必须补记
        needRecord: rec.failures > 0 && rec.records === 0,
        events: rec.events.slice(0, 12).map((e) => ({ at: isoOf(e.at), action: e.action, label: e.label, tool: e.tool, basis: e.basis }))
      });
    }
    const recent = list.slice().sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
    let current = null;
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      current = recent.find((r) => r.id === sessionId) ?? null;
    } else {
      current = recent.length > 0 ? recent[0] : null;
    }
    const totals = { sessions: list.length, queries: 0, records: 0, observedToolCalls: this.observed };
    for (const item of list) {
      totals.queries += item.queries;
      totals.records += item.records;
    }
    const out = {
      updatedAt: new Date().toISOString(),
      build: BUILD,
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
      ledger: { entries: this.ledger.entries, relapse: this.ledger.relapse, revised: this.ledger.revised, files: this.ledger.files, at: isoOf(this.ledger.at), error: this.ledger.error },
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
