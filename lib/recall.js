/**
 * dsh-ledger-watch · 经验召回（自动召回 / auto-recall）· v2
 *
 * 目的：把账本里的规则**在任务开始时按相关性送进上下文**，而不是等模型想起来去查。
 *
 * v2 打分（2026-10-27 验收后重做，v1 精确率仅约 55%）：
 *   v1 的三个根因 → v2 的修法
 *   ① 中文 token 按整段游程切分（「插件的界面」算一个 token，几乎不可能命中）
 *      → 改成从**任务文本**切中文双字组 + ASCII 词
 *   ② 双字组只用 title（trigger 是用户原话、最该参与匹配，却完全没参与）
 *      → 匹配对象改成 title + trigger + symptom 三段
 *   ③ 没有最低分门槛，任何 1 分的弱命中（「一个」「说明」）都会入选
 *      → 引入 IDF 权重 + 最低分门槛：出现在大量条目里的常见词几乎不计分
 *
 * 另外：limit 有默认值（v1 不传 limit 会静默返回空）；注入文本截断时保证帧闭合。
 *
 * @module dsh-ledger-watch/recall
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ENTRY_RE = /^##\s+((?:ENV|DSH|DATA|PRC|WS-[A-Z0-9]+)-\d{3})\s+/;
const RELAPSE_MARK = '复发记录';
const REVISION_MARK = '修订记录';
const FIELD_RE = {
  trigger: /^- \*\*触发场景\*\*：(.+)$/,
  symptom: /^- \*\*症状\*\*：(.+)$/,
  rule: /^- \*\*规则\*\*：(.+)$/,
  hits: /^- \*\*命中次数\*\*：(\d+)/,
  status: /^- \*\*状态\*\*：(.+)$/
};
const MAX_ITEMS = 500;
const SCAN_DIRS = ['lessons', 'workspaces'];
const DEFAULT_LIMIT = 4;
/** 最低分：单个常见中文双字组（权重≈1）不足以入选，需要更强证据。 */
const MIN_SCORE = 2;
const TEXT_LIMIT = 1500;
const RECALL_TEXT_LIMIT = 1800;
const CHINESE_GRAM_LEN = 2;
/** 至少要命中 2 个不同特征（单个偶然双字组不足以入选）。 */
const MIN_MATCHES = 2;
/* ---- 高置信模式（方案 B）常量 ---- */
/** 投递门槛：榜首必须达到这个绝对分（弱命中整批丢弃）。 */
const CONF_MIN_SCORE = 8;
/** 榜首必须比第二名高出这个倍数，否则视为「分不清」，不注入。 */
const CONF_MARGIN = 1.5;
/** 元条目（讲召回/账本自身机制的条目）只在任务本身是元任务时才允许进入候选池。 */
const META_HINT = /召回|门槛|夹具|打分|精确率|IDF|阈值|元条目|自指/;
/** 条目 ID 是否被**独立**提及（防子串碰撞：ws-fdsh-012 不应命中 dsh-012）。 */
export function idMentioned(raw, id) {
  const needle = id.toLowerCase();
  let idx = raw.indexOf(needle);
  while (idx >= 0) {
    const before = idx === 0 ? '' : raw[idx - 1];
    const after = raw[idx + needle.length] || '';
    if (!/[a-z0-9-]/.test(before) && !/[a-z0-9-]/.test(after)) return true;
    idx = raw.indexOf(needle, idx + 1);
  }
  return false;
}

/**
 * 高置信模式的运行点。minScore 不再是绝对值（PRC-016）：写成**语料规模的函数** ——
 * 等价于「至少两条中等稀有特征（df≈N/2 各一条）或一条专属特征加一条中频特征」。
 * N=87 → 2×(1+ln43.5) ≈ 9.54（与扫描出的拐点 min10 一致）；N=3 → ≈2.81（小语料不会静默失效）。
 */
export const CONF = { margin: 1.5, maxItems: 1, metaVeto: true };
/** 相对门槛：与语料规模无关的写法，N 变则门槛跟着变。 */
export function confMinScore(n) {
  const size = Number.isFinite(n) && n > 2 ? n : 3;
  return 2 * (1 + Math.log(size / 2));
}
/** 常见功能词双字组：小语料里 IDF 不稳定，必须显式停用，否则「今天/什么」这类词会把无关任务召回。 */
const GRAM_STOP = new Set([
  '一个', '我们', '你们', '他们', '什么', '怎么', '这个', '那个', '这些', '那些', '可以', '不能',
  '没有', '就是', '不是', '如果', '因为', '所以', '但是', '然后', '现在', '今天', '明天', '昨天',
  '时候', '一下', '一样', '一起', '已经', '还是', '或者', '而且', '以及', '为了', '这样', '那样',
  '自己', '大家', '只是', '有点', '真的', '好像', '应该', '觉得', '知道', '并且', '于是', '另外'
]);

/**
 * 扫账本：返回统计与可召回的条目列表。
 * @param ledgerDir - 账本根目录
 * @returns { stats, items }；失败时 stats.error 有值、items 为空
 */
export function scanLedger(ledgerDir) {
  const stats = { entries: 0, relapse: 0, revised: 0, files: 0, at: Date.now(), error: null };
  const items = [];
  try {
    let scanned = 0;
    for (const sub of SCAN_DIRS) {
      const dir = join(ledgerDir, sub);
      if (!existsSync(dir)) continue;
      scanned += 1;
      for (const name of readdirSync(dir)) {
        if (!name.toLowerCase().endsWith('.md')) continue;
        if (name.startsWith('_') || name === 'WORKSPACES.md') continue;
        let text;
        try { text = readFileSync(join(dir, name), 'utf8'); } catch (error) { continue; }
        stats.files += 1;
        let current = null;
        const flush = () => { if (current !== null) { items.push(current); current = null; } };
        for (const line of text.split(/\r?\n/)) {
          const head = line.match(ENTRY_RE);
          if (head !== null) {
            flush();
            current = {
              id: head[1],
              title: line.slice(head[0].length).trim(),
              trigger: '', symptom: '', rule: '', status: '', hits: 0, file: name
            };
            stats.entries += 1;
            continue;
          }
          if (line.indexOf(RELAPSE_MARK) >= 0) { stats.relapse += 1; continue; }
          if (line.indexOf(REVISION_MARK) >= 0) { stats.revised += 1; continue; }
          if (current === null) continue;
          for (const key of Object.keys(FIELD_RE)) {
            const m = line.match(FIELD_RE[key]);
            if (m === null) continue;
            if (key === 'hits') current.hits = Number(m[1]) || 0;
            else current[key] = m[1].trim();
            break;
          }
        }
        flush();
      }
    }
    if (scanned === 0) stats.error = 'lessons/ 与 workspaces/ 都不存在';
  } catch (error) {
    stats.error = String((error && error.message) || error).slice(0, 200);
  }
  if (items.length > MAX_ITEMS) items.length = MAX_ITEMS;
  return { stats, items };
}

/**
 * 从文本里取候选特征：ASCII 词（长度 ≥2，小写）+ 中文双字组（去重）。
 * 注意方向：特征取自**任务文本**，去匹配条目的正文 —— v1 反过来做，导致条目里的常见词把无关任务也召回来。
 * @param text - 任务文本
 * @returns 去重后的特征数组
 */
export function featuresOf(text) {
  const s = String(text || '').toLowerCase();
  const out = new Set();
  for (const token of s.split(/[^a-z0-9\u4e00-\u9fa5]+/)) {
    if (token.length >= 2) out.add(token);
  }
  const han = s.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const run of han) {
    for (let i = 0; i + CHINESE_GRAM_LEN <= run.length; i += 1) {
      const gram = run.slice(i, i + CHINESE_GRAM_LEN);
      if (GRAM_STOP.has(gram)) continue;
      out.add(gram);
    }
  }
  return [...out];
}

/** 条目参与匹配的正文（title + trigger + symptom）。 */
function blobOf(item) {
  return (item.title + ' ' + item.trigger + ' ' + item.symptom).toLowerCase();
}

/**
 * 按任务文本召回最相关的条目（IDF 加权 + 最低分门槛）。
 * @param text - 任务文本（截断到 1500 字符）
 * @param items - scanLedger 返回的条目
 * @param limit - 最多返回几条（默认 4）
 * @returns 命中的条目数组（按分数降序）
 */
/**
 * 同义扩展：用户/模型的说法常常与账本用词不同（说「固化经验」而账本写「add-lesson 条目」），
 * 只靠字面匹配会系统性漏召。命中左侧说法时把右侧的账本用词一并作为特征。
 */
const ALIAS_RULES = [
  { re: /固化|记下来|记录下来|沉淀|存档|复盘|总结教训|不再犯|避免再犯|避坑|踩坑|教训/, add: '账本 经验 分层 全局 工作区 判定 条目 规则 命中次数 复发记录 修订记录 收尾自报' },
  { re: /召回|检索|搜一下|查找经验|查账本|查一下经验/, add: '账本 关键词 命中 召回' },
  { re: /界面|样式|配色|对比度|字体|主题|深色模式/, add: '设计 token 界面 面板 药丸 会话 tab 指示灯' },
  { re: /重启|生效|没生效|热更新|重新加载|改了没反应/, add: 'bundle 重启 热重载 包名 specifier 载荷' },
  { re: /写盘|保存失败|写不进去|权限|占用/, add: '原子写 rename EPERM 临时文件 并发读者' },
  { re: /截图|无头|浏览器|自动化|点击没反应|点不动/, add: 'CDP 无头 Edge cookie 鉴权 dispatchMouseEvent' },
  { re: /插件|bundle|客户端|面板/, add: '插件 bundle client 载荷 三处 id 订阅' },
  { re: /专家|评审|验收|测试/, add: '专家 评审 验收 回归' }
];

/**
 * 只返回别名规则**追加**的词（不含原文）。
 * 调用方要用它把「字面证据」与「同义补齐」分开加权 —— 混在一起会抬高分值，
 * 让相对门槛反过来切掉语义正确的条目（验收实测：精确率 70.8% → 60.6%）。
 * @param text - 任务文本
 * @returns 追加词拼成的字符串（无命中则空串）
 */
export function aliasExpansionOf(text) {
  const raw = String(text || '');
  const extra = [];
  for (const rule of ALIAS_RULES) if (rule.re.test(raw)) extra.push(rule.add);
  return extra.join(' ');
}

/** 把任务文本按同义规则扩展成更接近账本用词的检索文本（保留导出：旧调用方与用例仍在用）。 */
export function expandText(text) {
  const raw = String(text || '');
  const extra = aliasExpansionOf(raw);
  return extra.length === 0 ? raw : raw + ' ' + extra;
}

/**
 * 按任务文本召回最相关的条目（IDF 加权 + 相对门槛）。
 * @param text - 任务文本（截断到 1500 字符）
 * @param items - scanLedger 返回的条目
 * @param limit - 最多返回几条（默认 4）
 * @returns 命中的条目数组（按分数降序）
 */
export function recallFor(text, items, limit) {
  const top = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT;
  // 先截断再扩展：否则长任务文本会把别名追加词挤出 1500 字符窗口（验收指出）
  const raw = String(text || '').slice(0, TEXT_LIMIT).toLowerCase();
  if (raw.length < 4 || !Array.isArray(items) || items.length === 0) return [];

  const literalFeatures = featuresOf(raw);
  const literalSet = new Set(literalFeatures);
  const aliasFeatures = featuresOf(aliasExpansionOf(raw)).filter((feature) => !literalSet.has(feature));
  const features = [...literalFeatures, ...aliasFeatures];
  if (features.length === 0) return [];
  const blobs = items.map(blobOf);

  // 文档频率：出现在越少条目里的特征越有信息量（「磁盘」≫「一个」）
  const df = new Map();
  for (const feature of features) {
    let n = 0;
    for (const blob of blobs) if (blob.indexOf(feature) >= 0) n += 1;
    df.set(feature, n);
  }
  // df=1 是最有信息量的（只在一个条目里出现的专属词），但 1+ln(N/df) 在 N=1 时恰好 = 1，
  // 等于把稀有词当常见词处理 → 小语料上静默召回为空（验收 v2.1 报告 §1.4 实测）。显式加权。
  const weightOf = (feature) => {
    const n = df.get(feature) || 0;
    if (n === 0) return 0;
    if (n === 1) return 3;
    return 1 + Math.log(items.length / n);
  };

  const scored = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const blob = blobs[i];
    let literalScore = 0;
    let aliasScore = 0;
    let matches = 0;
    let asciiMatches = 0;
    let rareMatches = 0;      // df <= N/4 的特征数（强信号）
    let bestWeight = 0;       // 该条自己命中的最强特征权重
    let idHit = false;
    if (idMentioned(raw, item.id)) { literalScore += 6; matches += 2; idHit = true; }
    for (const feature of literalFeatures) {
      if (blob.indexOf(feature) < 0) continue;
      const w = weightOf(feature);
      literalScore += w;
      if (w > bestWeight) bestWeight = w;
      if ((df.get(feature) || 0) * 4 <= items.length) rareMatches += 1;
      matches += 1;
      if (feature.length >= 3 && /^[a-z0-9]+$/.test(feature)) asciiMatches += 1;
    }
    for (const feature of aliasFeatures) {
      if (blob.indexOf(feature) < 0) continue;
      aliasScore += weightOf(feature) * 0.5;   // 同义补齐只算一半权重
      matches += 1;
    }
    const aliasDominated = aliasScore >= literalScore;
    // PRC-016：门槛只用**该条自己**的量，与榜首分数无关（榜首越高越容易连带抬门槛 = 上一版误伤源）。
    const need = Math.max(MIN_SCORE, 2 * bestWeight, aliasDominated ? MIN_SCORE * 2 : MIN_SCORE);
    // 准入条件：命中 ≥3 特征且至少一个 df<=N/4 的强信号；或 ≥2 特征且不是别名主导。
    const enough = (matches >= 3 && rareMatches >= 1) || (matches >= MIN_MATCHES && !aliasDominated);
    // ① 点名 ID = 最强信号，直接进候选（否则会被 need 掐死，实测回归）；
    // ② 别名主导的候选一律不单独准入：同义补齐只能加强字面证据（S16「固化经验」误召「固化插件改动」）。
    if (idHit || (!aliasDominated && literalScore + aliasScore >= need && enough)) {
      scored.push({ item, score: literalScore + aliasScore, literalScore, matches, rareMatches, bestWeight, idHit });
    }
  }
  if (scored.length === 0) return [];
  scored.sort((a, b) => ((b.idHit ? 1 : 0) - (a.idHit ? 1 : 0)) || (b.score - a.score) || (b.item.hits - a.item.hits) || a.item.id.localeCompare(b.item.id));
  // ---- 高置信模式闸门（方案 B）----
  // ① 元条目只在元任务上出现；② 榜首必须够强；③ 榜首必须明显高于第二名；④ 默认只投 1 条。
  const taskIsMeta = META_HINT.test(raw);
  const metaIds = new Set(items.filter((it) => META_HINT.test(it.title)).map((it) => it.id));
  // 元条目否决让位于「点名 ID」：任务文本里写了这条 ID，就是用户点名要它。
  const pool = CONF.metaVeto ? scored.filter((entry) => taskIsMeta || !metaIds.has(entry.item.id) || entry.idHit === true) : scored;
  if (pool.length === 0) return [];
  const first = pool[0];
  const second = pool[1];
  // 任务文本里直接写了条目 ID = 最强信号：跳过强弱门槛（用户已经点名要这条）。
  const strong = first.idHit === true;
  if (!strong && first.score < confMinScore(items.length)) return [];
  if (!strong && second !== undefined && first.score < second.score * CONF.margin) return [];
  const cap = strong ? Math.min(top, 2) : Math.min(top, CONF.maxItems);
  const out = [first];
  for (const entry of pool.slice(1)) {
    if (out.length >= cap) break;
    // 后续条目必须接近榜首（同一条强命中簇），且本身也够强。
    if (entry.score >= first.score * 0.75 && (strong || entry.score >= confMinScore(items.length))) out.push(entry);
  }
  return out.map((entry) => entry.item);
}

/**
 * 组装注入文本（system-reminder 帧）。
 * 截断只作用于帧体，保证 </system-reminder> 一定闭合（v1 直接切整段，长条目会把闭合标签切掉）。
 * @param hits - recallFor 的结果
 * @param ledgerDir - 账本目录（写进提示便于回查）
 * @returns 注入文本
 */
export function buildRecallText(hits, ledgerDir) {
  const open = '<system-reminder>';
  const close = '</system-reminder>';
  const lines = ['经验账本召回（与本次任务相关，请按规则执行；完成后按账本约定回写命中）：'];
  for (const hit of hits) {
    lines.push('- ' + hit.id + ' ' + hit.title);
    if (hit.rule && hit.rule.length > 0) lines.push('  规则：' + hit.rule.slice(0, 240));
  }
  lines.push('（账本：' + ledgerDir + ' ｜ 查看：tools\\brief.ps1 -Keywords <本次关键词>）');
  const body = lines.join('\n');
  // 预算要减去两个换行 **再加** 截断后缀「\n…」的 2 个字符，否则实际会超出 2 个字符（D10）
  const budget = RECALL_TEXT_LIMIT - open.length - close.length - 2 - 2;
  const clipped = body.length > budget ? body.slice(0, budget) + '\n…' : body;
  return [open, clipped, close].join('\n');
}
