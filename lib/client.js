/**
 * dsh-ledger-watch · 浏览器半边（lazy-CJS factory bundle）
 *
 * 三处 id 必须逐字一致（否则静默跳过或报 duplicate factory registration，见 DSH-017）：
 *   cordis.patch.yml 的 name ／ package.json 的 name ／ 这里的 load({ id })
 *
 * 设计原则：只用宿主真实设计 token（见 DSH-019）；结论色只用在圆点上，文字用中性色（浅色下
 * state-*-primary 当文字只有 1.96–3.70:1，不可读）；时间一律本地化并带日期（DSH-022）。
 *
 * 本轮修复（2026-10-27，专家评审后）：
 *   P0-1 结论文字改中性色 + 彩点，对比度 1.96→15+
 *   P0-2 时间本地化 + 跨天带日期（原来是 iso.slice(11,19)，显示 UTC，差 8 小时）
 *   P0-3 「自动刷新」真生效（原来间隔写死 2000，开关只喂 checked）
 *   P0-4 轮询失败保留旧数据（stale 横幅），只有从未成功才整页报错
 *   P1   轮询改自调度 + 在飞保护 + 序号防乱序覆盖；data 类型守卫（防 tab 永久消失）；
 *        body class 引用计数 + disposer 兜底摘类；悬停改 CSS；事件行显示 tool；
 *        KPI 值降到 14px/600 且「结论」改为状态条；空态/加载态改进；列表截断有提示
 */
window.__ModuleLoader__.load({
  id: 'dsh-ledger-watch',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');

    const BUILD = 'c-2026-10-28 20:16 · attribution.1';
    const NS = 'settings.ledgerWatch';
    const inject = ['slots', 'locale', 'connection'];
    const REMOTE_METHOD_PARAMS = { state: ['sessionId'], evidence: [], report: ['clientBuild', 'note'] };
    const VIEW_CLASS = 'ledger-watch-view';
    const EVENT_LIMIT = 12;      // 收进详情区的上限（payload 最多给 12 条）
    const EVENT_FIRST = 3;       // 首屏只看 3 条：结论已经有数字，事件只是证据链
    const SESSION_LIMIT = 8;

    /* ---------- 视图标记引用计数：避免「谁先卸载谁摘类」和残留导致输入框永久消失 ---------- */
    let viewHolders = 0;
    function acquireViewClass() {
      viewHolders += 1;
      document.body.classList.add(VIEW_CLASS);
      return () => {
        viewHolders = Math.max(0, viewHolders - 1);
        if (viewHolders === 0) document.body.classList.remove(VIEW_CLASS);
      };
    }

    /* ---------- 样式：composer 隐藏 + 行悬停 + 焦点环（都用稳定 data 属性/类名） ---------- */
    const CSS = [
      'body.' + VIEW_CLASS + ' [data-composer-seat]{display:none !important}',
      'body.' + VIEW_CLASS + ' [data-conversation-scroll]{--dsh-composer-height:0px !important}',
      '.lw-row{border-radius:6px}',
      '.lw-skel{background:var(--dsw-alias-bg-skeleton,var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05)));border-radius:6px;animation:lw-pulse 1.4s ease-in-out infinite}',
      '@keyframes lw-pulse{0%,100%{opacity:1}50%{opacity:.55}}',
      '@media (prefers-reduced-motion: reduce){.lw-skel{animation:none}}'
    ].join('\n');

    const zh = {
      // 名词统一（产品评审 2026-10-28）：原来 tab 叫「避坑核对」、页脚叫「规则库」、正文说「经验账本」，
      // 同一个东西三个名字，用户在三个名字之间做语义换算。统一成「经验账本」——
      // 它比「避坑核对」多一个信息：它是什么（一本账），而不只是一个动作。
      tab: '经验账本', title: '经验账本',
      statusOn: '本会话已查经验账本', statusOff: '跑过工具，但没查经验账本', statusIdle: '本会话还没开始',
      statusOnHint: '查过账本，按规矩记录', statusOffHint: '任务已经在动，账本一次没查 —— 先跑 brief.ps1',
      statusIdleHint: '开始给我第一个任务即可；如果我没先查账本，这里会变红',
      diagnostics: '诊断详情',
      ledgerLib: '经验账本', ledgerEntries: '条', relapse: '失效待改', revised: '已修订',
      ledgerTruncated: '⚠ 账本已到召回上限：识别 {n} 条，只装载 {m} 条 —— 超出的部分不参与自动召回',
      recall: '自动召回', adopted: '被引用（推断）', hostBuild: '宿主 build', writeWarn: '证据文件写入失败 {n} 次 —— 面板数据可能停在旧值',
      // 召回常显（默认关闭时原来整行不渲染 → 用户不知道有这个功能）
      recallOff: '关闭', recallOn: '高置信模式', recallWhy: '未达准入：holdout 复测未通过，开了会投噪声。要开请在 profile 的插件配置里设',
      needRecord: '本会话出现了 {why}，却一条坑都没记 —— 收尾请用 add-lesson.ps1 补记',
      // 五类信号常显（原来只在「零记录」时出一条横幅，记了一条坑就整块消失）
      signals: '可疑信号', signalsNone: '暂无', signalsWhy: '这些只是可疑事件的计数，不等于坑；判断权在模型',
      refresh: '刷新', autoOn: '自动刷新', autoOff: '已暂停',
      failed: '读取失败', stale: '数据已过期', retry: '重试',
      noSession: '本会话还没有账本相关活动', noSessionHint: '开工先跑 brief.ps1 查询经验，收尾用 add-lesson.ps1 记坑（这两条由我执行）',
      unobserved: '本会话不在监视范围内', unobservedHint: '插件只在 DSH 启动后观测工具调用：重启前的老会话、或运行在其他进程里的会话不会被记到。这些会话不会出现在下面的统计里，也不代表它们没查过账本。',
      unobservedShort: '插件启动前就已存在的会话，没有观测数据',
      // 冷启动引导：陌生人第一屏不该是一根指认他做错事的红条（产品评审 2026-10-28 P0）
      onboardTitleMissing: '还没装经验账本技能 —— 本插件只是它的指示灯',
      onboardTitleEmpty: '经验账本技能已装，但里面还没有规则',
      onboardBody: '本插件不生产规则，规则来自 lesson-ledger 技能。它按工作区给条目分类、带索引、带命中计数。三步就能让它跑起来：',
      onboardStep1: '① 装技能（把 lesson-ledger 目录放到技能目录下）',
      onboardStep2: '② 把下面这段贴进 AGENTS.md（开工自报，让模型每次先查账本）',
      onboardStep3: '③ 记第一条坑（用 add-lesson.ps1），或者复制一句示例条目',
      onboardCopy: '复制',
      onboardCopied: '已复制',
      onboardSnippet: '动手前先跑：& "<账本目录>\\tools\\brief.ps1" -Keywords "<任务相关词>"，并把输出原样贴进回复。',
      onboardDir: '当前账本目录',
      queries: '查询', records: '记录', observed: '宿主工具调用（全局）',
      events: '最近事件', showAll: '展开全部 {n} 条', othersSummary: '其它会话 {n} 个', onlyShown: '仅显示 {n} / 共 {m}',
      evidence: '证据文件', build: 'build', client: '客户端回报', none: '无', times: '次',
      v_ok: '查了也记了', v_queryonly: '查了没记', v_recordnoquery: '记了没先查', v_missingquery: '没查账本', v_idle: '还没开始',
      h_ok: '本会话既查了账本，也记了坑', h_queryonly: '查过账本，但还没有记录新踩的坑',
      h_recordnoquery: '记了坑，但没有先查账本', h_missingquery: '任务已经动过工具，却一次没查账本',
      h_idle: '还没有账本相关活动', a_query: '查询', a_record: '记录', a_touch: '其它',
      pill: '账本', pillHint: '本会话查经验 / 记坑的次数（点上方「经验账本」看详情）'
    };
    const en = {
      tab: 'Lesson ledger', title: 'Lesson ledger',
      statusOn: 'Ledger checked in this session', statusOff: 'Tools ran, but the ledger was never checked', statusIdle: 'Nothing happened in this session yet',
      statusOnHint: 'consulted, and recorded by the rules', statusOffHint: 'the session is working but never looked it up - run brief.ps1 first',
      statusIdleHint: 'give me a first task; if I skip the ledger, this turns red',
      diagnostics: 'Diagnostics',
      ledgerLib: 'Lesson ledger', ledgerEntries: 'entries', relapse: 'needs rework', revised: 'revised',
      ledgerTruncated: 'Warning: recall pool capped - {n} entries recognized, only {m} loaded; the rest never take part in recall',
      recall: 'Auto-recall', recallOff: 'off', recallOn: 'high-confidence', recallWhy: 'below the admission bar: the holdout retest has not passed, so enabling it would inject noise. Set',
      adopted: 'adopted', hostBuild: 'Host build', writeWarn: 'Evidence writes failed {n} times - the panel may be showing stale data',
      signals: 'Suspicious signals', signalsNone: 'none', signalsWhy: 'counts of suspicious events, not pitfalls; the model decides',
      needRecord: 'This session showed {why} but recorded nothing - run add-lesson.ps1 before finishing',
      refresh: 'Refresh', autoOn: 'Auto', autoOff: 'paused',
      failed: 'Failed to read', stale: 'stale', retry: 'Retry',
      noSession: 'No ledger activity captured yet', noSessionHint: 'Run brief.ps1 to look up, add-lesson.ps1 to record',
      unobserved: 'This session is outside the watch scope', unobservedHint: 'The plugin only observes tool calls while DSH is running: sessions from before the last restart, or sessions in another process, are not recorded. They are absent from the stats below — it does not mean they skipped the ledger.',
      unobservedShort: 'created before the plugin started; no observation data',
      onboardTitleMissing: 'The lesson-ledger skill is not installed - this plugin is only its indicator',
      onboardTitleEmpty: 'The skill is installed, but it holds no rules yet',
      onboardBody: 'This plugin does not produce rules; they live in the lesson-ledger skill. Three steps:',
      onboardStep1: '1) install the skill (drop the lesson-ledger folder into the skills directory)',
      onboardStep2: '2) paste the snippet below into AGENTS.md (startup self-report)',
      onboardStep3: '3) record your first pitfall with add-lesson.ps1',
      onboardCopy: 'copy',
      onboardCopied: 'copied',
      onboardSnippet: 'Before working, run: & "<ledger dir>\\tools\\brief.ps1" -Keywords "<task words>" and paste its output verbatim into the reply.',
      onboardDir: 'Ledger directory',
      queries: 'Queries', records: 'Records', observed: 'Host tool calls (global)',
      events: 'Recent events', showAll: 'show all {n}', othersSummary: 'Other sessions: {n}', onlyShown: 'showing {n} of {m}',
      evidence: 'Evidence file', build: 'build', client: 'Client report', none: 'none', times: '',
      v_ok: 'checked + logged', v_queryonly: 'checked only', v_recordnoquery: 'logged, no check', v_missingquery: 'never checked', v_idle: 'not started',
      h_ok: 'Both looked up and recorded', h_queryonly: 'Looked up, nothing recorded yet',
      h_recordnoquery: 'Recorded without looking up first', h_missingquery: 'Tools ran but the ledger was never consulted',
      h_idle: 'No ledger activity yet', a_query: 'query', a_record: 'record', a_touch: 'other',
      pill: 'ledger', pillHint: 'Ledger lookups / pitfall records for this session'
    };

    function makeCall(ctx) {
      return async function call(method, ...args) {
        const names = REMOTE_METHOD_PARAMS[method];
        if (names === undefined) throw new Error('unknown remote method: ' + method);
        const named = {};
        names.forEach((name, index) => { named[name] = args[index]; });
        const result = await ctx.connection.rpc.call('/api', 'ledgerWatch/' + method, { args: named });
        if (!result || result.ok !== true) {
          const error = (result && result.error) || {};
          throw new Error(method + ' failed: ' + (error.code || 'UNKNOWN') + ' ' + (error.message || ''));
        }
        return result.value;
      };
    }

    /* ---------- 设计系统（只用宿主真实 token） ---------- */
    const CODE = 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)';
    const T = 'var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease-in-out)';
    const S = {
      page: {
        display: 'flex', flexDirection: 'column', gap: '16px',
        width: '100%', maxWidth: '920px', margin: '0 auto', boxSizing: 'border-box',
        padding: '18px clamp(20px, 4vw, 44px) 48px',
        fontSize: '13px', lineHeight: '1.5', color: 'var(--dsw-alias-label-primary)'
      },
      head: { display: 'flex', flexDirection: 'column', gap: '4px' },
      title: { margin: 0, fontSize: '20px', fontWeight: 500, lineHeight: '28px' },
      subtitle: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      bar: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      spacer: { flex: '1 1 auto' },
      pill: {
        display: 'inline-flex', alignItems: 'center', gap: '6px',
        padding: '3px 10px', borderRadius: '999px', fontSize: '12px', lineHeight: '18px',
        border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap'
      },
      btn: {
        font: 'inherit', fontSize: '12px', lineHeight: '18px', padding: '3px 12px', cursor: 'pointer',
        borderRadius: '999px', color: 'var(--dsw-alias-label-secondary)',
        border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)',
        transition: 'border-color ' + T + ', color ' + T
      },
      toggle: { display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      banner: {
        display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
        padding: '6px 10px', borderRadius: '8px', fontSize: '12px',
        border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)'
      },
      kpis: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))', gap: '12px' },
      kpi: {
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px', minWidth: 0,
        padding: '12px', borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)'
      },
      kpiLabel: { fontSize: '11px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' },
      kpiValue: { fontSize: '14px', fontWeight: 600, lineHeight: '20px', fontVariantNumeric: 'tabular-nums' },
      kpiUnit: { fontSize: '12px', fontWeight: 400, color: 'var(--dsw-alias-label-secondary)', marginLeft: '3px' },
      card: {
        display: 'flex', flexDirection: 'column', gap: '8px',
        padding: '12px 14px', borderRadius: '10px',
        border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)'
      },
      status: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap', fontSize: '12px' },
      sectionLabel: { fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      dim: { color: 'var(--dsw-alias-label-secondary)' },
      faint: { color: 'var(--dsw-alias-label-secondary)' },
      mono: { fontFamily: CODE, fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      rows: { display: 'flex', flexDirection: 'column', gap: '1px' },
      evRow: {
        display: 'grid', gridTemplateColumns: '82px minmax(0, 1fr)', gap: '10px', alignItems: 'baseline',
        padding: '5px 6px', fontSize: '12px'
      },
      sessRow: {
        display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr) auto auto', gap: '10px', alignItems: 'center',
        padding: '6px 6px', fontSize: '12px'
      },
      time: { fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-label-secondary)' },
      empty: {
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px',
        padding: '26px 12px', textAlign: 'center', borderRadius: '10px',
        border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-secondary)'
      },
      chip: {
        fontFamily: CODE, fontSize: '11px', padding: '1px 6px', borderRadius: '4px',
        border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-secondary)'
      },
      errorBox: {
        fontFamily: CODE, fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)',
        background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '6px', padding: '4px 8px', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap'
      },
      spine: {
        display: 'flex', flexDirection: 'column', gap: '6px',
        padding: '12px 14px', borderRadius: '10px',
        border: '1px solid var(--dsw-alias-border-l2)', borderLeft: '3px solid var(--dsw-alias-border-l3)',
        background: 'var(--dsw-alias-bg-layer-1)'
      },
      spineMain: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' },
      spineSub: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', fontSize: '12px' },
      details: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      foot: { display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '14px', flexWrap: 'wrap', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', marginTop: 'auto' },
      warnText: { color: 'var(--dsw-alias-state-warn-primary)', fontWeight: 500 },
      sigRow: {
        display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
        padding: '4px 2px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)'
      },
      sigLabel: { fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' },
      onboard: {
        display: 'flex', flexDirection: 'column', gap: '8px',
        padding: '14px 16px', borderRadius: '10px', fontSize: '12px',
        border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-secondary)'
      },
      snippetRow: { display: 'flex', alignItems: 'flex-start', gap: '8px', flexWrap: 'wrap' },
      snippet: {
        flex: '1 1 320px', minWidth: 0, fontFamily: CODE, fontSize: '11px', lineHeight: '17px',
        padding: '6px 8px', borderRadius: '6px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
        border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)'
      },
      dot: { width: '7px', height: '7px', borderRadius: '999px', flex: 'none', display: 'inline-block', boxShadow: '0 0 0 1px var(--dsw-alias-border-l3)' }
    };

    /** 结论 → 颜色（只用于圆点）。 */
    function verdictColor(verdict) {
      if (verdict === 'ok') return 'var(--dsw-alias-state-success-primary)';
      if (verdict === 'missing-query') return 'var(--dsw-alias-state-error-primary)';
      if (verdict === 'query-only' || verdict === 'record-no-query') return 'var(--dsw-alias-state-warn-primary)';
      return 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))';
    }
    function verdictText(t, verdict) {
      if (verdict === 'ok') return t('v_ok');
      if (verdict === 'missing-query') return t('v_missingquery');
      if (verdict === 'query-only') return t('v_queryonly');
      if (verdict === 'record-no-query') return t('v_recordnoquery');
      return t('v_idle');
    }
    function verdictHint(t, verdict) {
      if (verdict === 'ok') return t('h_ok');
      if (verdict === 'missing-query') return t('h_missingquery');
      if (verdict === 'query-only') return t('h_queryonly');
      if (verdict === 'record-no-query') return t('h_recordnoquery');
      return t('h_idle');
    }
    /** 结论 = 彩点 + 中性色文字（对比度优先，色相语义留在圆点上）。 */
    function Verdict(props) {
      const t = props.t;
      return React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' }, title: verdictHint(t, props.verdict) },
        React.createElement('span', { style: { ...S.dot, background: verdictColor(props.verdict) }, 'aria-hidden': 'true' }),
        React.createElement('span', { style: { fontWeight: 600 } }, verdictText(t, props.verdict))
      );
    }
    function actionLabel(t, action) {
      if (action === 'query') return t('a_query');
      if (action === 'record') return t('a_record');
      return t('a_touch');
    }
    /**
     * 时间：一律本地化。今天 → HH:MM:SS；昨天 → 昨天 HH:MM；更早 → MM-DD HH:MM。
     * （原来直接 iso.slice(11,19) 取的是 UTC，比本地早 8 小时，跨天还会看着像乱序）
     */
    function clockOf(iso) {
      if (typeof iso !== 'string') return '--:--';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '--:--';
      const now = new Date();
      const sameDay = d.toDateString() === now.toDateString();
      const y = new Date(now.getTime() - 86400000);
      const pad = (n) => String(n).padStart(2, '0');
      const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
      if (sameDay) return hm + ':' + pad(d.getSeconds());
      if (d.toDateString() === y.toDateString()) return '昨天 ' + hm;
      return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + hm;
    }
    function fullTime(iso) {
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('zh-CN', { hour12: false });
    }
    function shortId(id) { return typeof id === 'string' && id.length > 22 ? id.slice(0, 22) + '…' : String(id || '-'); }
    /** 会话身份的规范化键：与宿主半边同一条规则（去 session- 前缀，忽略大小写）。 */
    function sessKey(id) { return typeof id === 'string' ? id.trim().toLowerCase().replace(/^session-/, '') : ''; }
    function errorCodeOf(text) {
      const m = /[a-z]+\/[a-z][a-z-]*/.exec(String(text || ''));
      return m === null ? '' : m[0];
    }
    function isPlainObject(v) { return typeof v === 'object' && v !== null && !Array.isArray(v); }

    /**
     * 本插件的 tab 当前是否在屏（靠 body class 判断）。
     * 药丸被 CSS 藏起来时仍会挂载 → 必须让它停止轮询（评审 M6）。
     */
    function useViewActive() {
      const [active, setActive] = React.useState(() => document.body.classList.contains(VIEW_CLASS));
      React.useEffect(() => {
        const update = () => setActive(document.body.classList.contains(VIEW_CLASS));
        const observer = new MutationObserver(update);
        observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        update();
        return () => observer.disconnect();
      }, []);
      return active;
    }

    /**
     * 轮询：自调度（不在飞堆积）+ 序号防乱序覆盖 + 失败保留旧数据 + 页面隐藏时停轮询。
     * @param call - RPC
     * @param sessionId - 会话
     * @param intervalMs - 间隔；<=0 表示暂停（仍会立刻拉一次）
     */
    function useWatchState(call, sessionId, intervalMs) {
      const [state, setState] = React.useState({ status: 'loading', data: null, error: null, at: null });
      const sid = typeof sessionId === 'string' ? sessionId : '';
      const seqRef = React.useRef(0);
      const aliveRef = React.useRef(true);
      const load = React.useCallback(async () => {
        const seq = ++seqRef.current;
        try {
          const data = await call('state', sid);
          if (!aliveRef.current || seq !== seqRef.current) return;   // 已卸载 或 有更新的响应在飞
          if (!isPlainObject(data)) throw new Error('malformed payload: ' + typeof data);
          setState({ status: 'ready', data: data, error: null, at: Date.now() });
        } catch (error) {
          if (!aliveRef.current || seq !== seqRef.current) return;
          setState((prev) => prev.data === null
            ? { status: 'failed', data: null, error: String((error && error.message) || error), at: null }
            : { status: 'stale', data: prev.data, error: String((error && error.message) || error), at: prev.at });
        }
      }, [call, sid]);
      React.useEffect(() => {
        aliveRef.current = true;
        load();
        if (!(intervalMs > 0)) return () => { aliveRef.current = false; };
        let timer = null;
        let stopped = false;
        const tick = async () => {
          if (stopped) return;
          if (document.visibilityState === 'visible') await load();
          if (!stopped) timer = setTimeout(tick, intervalMs);
        };
        timer = setTimeout(tick, intervalMs);
        const onVisible = () => { if (document.visibilityState === 'visible' && !stopped) load(); };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
          stopped = true;
          aliveRef.current = false;
          if (timer !== null) clearTimeout(timer);
          document.removeEventListener('visibilitychange', onVisible);
        };
      }, [load, intervalMs]);
      return [state, load];
    }

    function Kpi(props) {
      return React.createElement('div', { style: S.kpi },
        React.createElement('span', { style: S.kpiLabel }, props.label),
        React.createElement('span', { style: S.kpiValue }, String(props.value),
          props.unit ? React.createElement('span', { style: S.kpiUnit }, props.unit) : null)
      );
    }
    function Skeleton() {
      return React.createElement('div', { style: S.page },
        React.createElement('div', { style: S.head },
          React.createElement('h2', { style: S.title }, '…'),
          React.createElement('p', { style: S.subtitle }, ' ')
        ),
        React.createElement('div', { style: S.kpis },
          [0, 1, 2].map((i) => React.createElement('div', { key: i, className: 'lw-skel', style: { height: '58px' } }))),
        React.createElement('div', { className: 'lw-skel', style: { height: '120px' } })
      );
    }

    /** 输入框下方常驻药丸（在本 tab 里会随输入框一起隐藏）。 */
    function LedgerPill(props) {
      const t = props.t;
      const viewActive = useViewActive();
      // 本 tab 在屏时药丸被隐藏，停轮询（否则 display:none 仍每 5 秒打一次 RPC）
      const [state] = useWatchState(props.call, props.sessionId, viewActive ? 0 : 5000);
      const cur = state.status !== 'failed' && isPlainObject(state.data) ? state.data.current : null;
      const label = cur
        ? t('pill') + ' ' + cur.queries + ' / ' + cur.records
        : t('pill') + ' ' + (state.status === 'failed' ? t('failed') : '—');
      return React.createElement('span', {
        style: { ...S.pill, padding: '2px 10px' },
        title: (state.status === 'failed' ? state.error + '\n' : t('pillHint') + '\n') + t('build') + ' ' + BUILD
      },
        React.createElement('span', { style: { ...S.dot, background: verdictColor(cur ? cur.verdict : 'idle') }, 'aria-hidden': 'true' }),
        React.createElement('span', null, label)
      );
    }

    /** 会话上方 tab 的正文。 */
    function LedgerWatchView(props) {
      const t = props.t;
      const [auto, setAuto] = React.useState(true);
      const [state, load] = useWatchState(props.call, props.sessionId, auto ? 2000 : 0);

      React.useEffect(() => acquireViewClass(), []);

      if (state.status === 'loading') return Skeleton();
      const data = isPlainObject(state.data) ? state.data : null;

      // 账本三态要在**所有**分支出结果之前算好：它同时决定引导卡、指示灯颜色、
      // 「其它会话」行是否判红。放到后面会踩 TDZ（React.createElement 的参数是立即求值的）。
      const ledgerStatus = data && data.ledger && data.ledger.status ? data.ledger.status : 'ready';
      const needsOnboard = ledgerStatus === 'missing' || ledgerStatus === 'empty';

      const header = React.createElement('div', { style: S.head },
        React.createElement('h2', { style: S.title }, t('title')),
      );

      if (data === null) {
        return React.createElement('div', { style: S.page, role: 'tabpanel' }, header,
          React.createElement('div', { style: S.card },
            React.createElement('div', { style: S.status },
              React.createElement('span', { style: { ...S.dot, background: 'var(--dsw-alias-state-error-primary)' }, 'aria-hidden': 'true' }),
              React.createElement('span', { style: { fontWeight: 600 } }, t('failed'))
            ),
            React.createElement('div', { style: S.errorBox }, String(state.error || '')),
            React.createElement('div', { style: S.bar },
          React.createElement('button', { style: S.btn, type: 'button', onClick: load }, t('retry')),
          React.createElement('label', { style: S.toggle },
            React.createElement('input', { type: 'checkbox', checked: auto, onChange: (e) => setAuto(e.target.checked) }),
            auto ? t('autoOn') : t('autoOff')),
          React.createElement('span', { style: S.spacer }),
          // 失败分支里 data 恒为 null：这里过去读 data.build 会在渲染期抛 TypeError，
          // 于是「读取失败」这块唯一用于报错的界面反而白屏（2026-10-28 评审 P0）。
          React.createElement('span', { style: S.pill }, t('hostBuild') + '：—')
        )
          )
        );
      }

      const cur = isPlainObject(data.current) ? data.current : null;
      const curVerdict = cur ? cur.verdict : 'idle';
      const evAll = cur && Array.isArray(cur.events) ? cur.events : [];
      // 会话 id 有两种写法（带 session- 前缀 / 裸 uuid），与本会话比较必须归一化，
      // 否则同一个会话会既出现在结论脊里、又出现在「其它会话」里。
      const sameSession = (a, b) => sessKey(a) === sessKey(b) && sessKey(a).length > 0;
      const others = Array.isArray(data.sessions) ? data.sessions.filter((s) => !cur || !sameSession(s.id, cur.id)) : [];

      const bar = React.createElement('div', { style: S.bar },
        React.createElement('button', { style: S.btn, type: 'button', onClick: load }, t('refresh')),
        React.createElement('label', { style: S.toggle },
          React.createElement('input', { type: 'checkbox', checked: auto, onChange: (e) => setAuto(e.target.checked) }),
          auto ? t('autoOn') : t('autoOff')
        ),
        state.status === 'stale'
          ? React.createElement('span', { style: S.banner, role: 'status', title: String(state.error || '') },
              React.createElement('span', { style: { ...S.dot, background: 'var(--dsw-alias-state-warn-primary)' }, 'aria-hidden': 'true' }),
              t('stale') + ' · ' + t('retry'),
              React.createElement('button', { style: S.btn, type: 'button', onClick: load }, t('retry')))
          : null,
        React.createElement('span', { style: S.spacer })
      );

      // 状态行卡已删除：结论改由状态脊承担，避免同一结论在一屏里渲染两遍（UI + UX 评审一致）
      // 「轮次」也删掉：它不参与任何判定，却占一张卡（2026-10-28 评审）
      const kpis = React.createElement('div', { style: S.kpis },
        React.createElement(Kpi, { label: t('queries'), value: cur ? cur.queries : 0, unit: t('times') }),
        React.createElement(Kpi, { label: t('records'), value: cur ? cur.records : 0, unit: t('times') })
      );

      // 事件：首屏 3 行，其余收进 details（2026-10-28 评审：10 行 ≈240px 是一屏最大块，
      // 而产品问题是「有没有查」，不是「每一行是什么」）。tool 列也删掉——对账本事件它恒为 pwsh，
      // 而 label 里已经点名了脚本。行不再可聚焦：它们没有点击行为，可聚焦等于骗键盘用户。
      const eventRow = (ev, i) => React.createElement('div', {
        key: (ev.at || '') + '-' + (ev.tool || '') + '-' + i,
        className: 'lw-row', style: S.evRow, title: fullTime(ev.at) + (ev.basis ? '　·　依据：' + ev.basis : '')
      },
        React.createElement('span', { style: S.time }, clockOf(ev.at)),
        React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '5px', minWidth: 0, overflow: 'hidden' } },
          React.createElement('span', { style: { ...S.dot, background: ev.action === 'record' ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))' }, 'aria-hidden': 'true' }),
          React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: ev.tool || '' }, ev.label || actionLabel(t, ev.action))
        )
      );
      const evHead = evAll.slice(0, EVENT_FIRST);
      const evRest = evAll.slice(EVENT_FIRST, EVENT_LIMIT);
      const evShown = evHead.length + evRest.length;
      const eventsCard = evAll.length === 0 ? null : React.createElement('div', { style: S.card },
        React.createElement('span', { style: S.sectionLabel }, t('events')),
        React.createElement('div', { style: S.rows },
          evHead.map(eventRow),
          evRest.length === 0 ? null : React.createElement('details', { style: S.details },
            React.createElement('summary', { style: { cursor: 'pointer', fontSize: '11px', opacity: 0.85 } },
              t('showAll').replace('{n}', String(evShown))),
            evRest.map((ev, i) => eventRow(ev, i + EVENT_FIRST)),
            // 摘要里的数字必须等于它真的列出的行数（评审 B3：一个以「如实报告」为卖点的面板，
            // 印不可核对的计数比不印更坏）
            evAll.length > evShown
              ? React.createElement('span', { style: { ...S.dim, fontSize: '11px', paddingTop: '2px' } },
                  t('onlyShown').replace('{n}', String(evShown)).replace('{m}', String(evAll.length)))
              : null
          )
        )
      );

      // 其它会话折叠成一行摘要（评审：与本会话判定无关，README 也写明「不是监控用户行为的工具」）
      const shownOthers = others.slice(0, SESSION_LIMIT);
      const othersCard = others.length === 0 ? null : React.createElement('details', { style: S.details },
        React.createElement('summary', { style: { cursor: 'pointer', fontSize: '11px', opacity: 0.85 } },
          t('othersSummary').replace('{n}', String(others.length))),
        React.createElement('div', { style: S.rows },
          shownOthers.map((s, i) => React.createElement('div', {
            key: sessKey(s.id) + '-' + i, className: 'lw-row', style: S.sessRow, title: s.id
          },
            // 没有账本可查时不能判红：那不是这些会话的错（产品评审 2026-10-28）
            React.createElement(Verdict, { t: t, verdict: needsOnboard ? 'idle' : s.verdict }),
            React.createElement('span', { style: S.mono }, shortId(s.id)),
            React.createElement('span', { style: { ...S.dim, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } }, t('queries') + ' ' + s.queries + ' · ' + t('records') + ' ' + s.records),
            React.createElement('span', { style: S.time, title: fullTime(s.lastAt) }, clockOf(s.lastAt))
          )),
          others.length > shownOthers.length
            ? React.createElement('span', { style: { ...S.dim, fontSize: '11px', paddingTop: '2px' } },
                t('onlyShown').replace('{n}', String(shownOthers.length)).replace('{m}', String(others.length)))
            : null
        )
      );

      // 空态必须分两种：插件**从没观测到**这个会话（重启前的老会话 / 别的进程里的会话）
      // vs 观测到了但本会话还没有账本活动。混为一谈会让用户以为「每个会话看到的都一样」。
      const unobserved = data.sessionKnown === false;
      const emptyCard = cur === null ? React.createElement('div', { style: S.empty },
        React.createElement('span', { style: { fontWeight: 500, color: 'var(--dsw-alias-label-primary)' } },
          unobserved ? t('unobserved') : t('noSession')),
        React.createElement('span', null, unobserved ? t('unobservedHint') : t('noSessionHint')),
        // 未观测的会话跑脚本也不会被记到：给它两个「该跑什么」的 chip 是错误建议（评审 C）
        unobserved ? null : React.createElement('span', null,
          React.createElement('span', { style: S.chip }, 'brief.ps1'), ' ', React.createElement('span', { style: S.chip }, 'add-lesson.ps1'))
      ) : null;

      // 页脚：常态只留一个折叠入口 + 截断告警。
      // 账本健康度与召回状态挪进 details（评审：召回默认关、面板内不可操作，占常显行却对 5 秒任务 0 贡献）
      const recallMode = data.recall ? String(data.recall.mode || 'off') : 'off';
      const recallOn = recallMode !== 'off';
      const foot = React.createElement('div', { style: S.foot },
        data.ledger && data.ledger.truncated
          ? React.createElement('span', { style: S.warnText },
              t('ledgerTruncated').replace('{n}', String(data.ledger.recognized)).replace('{m}', String(data.ledger.recallPool)))
          : null,
        React.createElement('span', { style: S.spacer }),
        React.createElement('details', { style: S.details },
          React.createElement('summary', { style: { cursor: 'pointer' } }, t('diagnostics')),
          React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', paddingTop: '4px' } },
            data.ledger ? React.createElement('span', null, t('ledgerLib') + '：' + data.ledger.entries + t('ledgerEntries') +
              (data.ledger.relapse > 0 ? '　·　' + t('relapse') + ' ' + data.ledger.relapse : '') +
              (data.ledger.revised > 0 ? '　·　' + t('revised') + ' ' + data.ledger.revised : '')) : null,
            React.createElement('span', { title: recallOn ? '' : t('recallWhy') + ' recallMode: \'high-confidence\'' },
              t('recall') + '：' + (recallOn ? t('recallOn') + '（' + (data.recalls || 0) + ' 次 · ' + t('adopted') + ' ' + (data.recallCitedIds || 0) + '）' : t('recallOff'))),
            React.createElement('span', null, t('client') + '：' + (data.client ? data.client.build + ' · ' + data.client.note + ' · ' + clockOf(data.client.at) : t('none'))),
            React.createElement('span', { style: S.mono }, t('hostBuild') + '：' + (data.build || '-')),
            React.createElement('span', null, t('observed') + '：' + (data.observedToolCalls || 0)),
            React.createElement('span', { style: { ...S.mono, whiteSpace: 'normal', overflowWrap: 'anywhere' } }, t('evidence') + '：' + (data.evidencePath || '-')),
            React.createElement('span', { style: { ...S.mono, whiteSpace: 'normal', overflowWrap: 'anywhere' } }, t('onboardDir') + '：' + (data.ledgerDir || '-')),
            data.ledger && data.ledger.error
              ? React.createElement('span', { style: { ...S.mono, whiteSpace: 'normal', overflowWrap: 'anywhere' } }, 'ledger: ' + data.ledger.error)
              : null
          )
        )
      );

      // 五类可疑信号常显（产品评审 2026-10-28 P1）：原来 48 条用例建起来的引擎只在「零记录」时
      // 出一条横幅，用户记了一条坑整块就消失 —— 引擎产能远超界面出口。
      const sig = cur && isPlainObject(cur.signals) ? cur.signals : null;
      const sigPairs = sig === null ? [] : [
        ['failures', '失败'], ['retries', '重复'], ['rewrites', '反复改'], ['corrections', '被纠正'], ['churn', '空转']
      ].filter((p) => (sig[p[0]] || 0) > 0);
      const signalsRow = cur === null ? null : React.createElement('div', { style: S.sigRow, title: t('signalsWhy') },
        React.createElement('span', { style: S.sigLabel }, t('signals')),
        sigPairs.length === 0
          ? React.createElement('span', { style: S.dim }, t('signalsNone'))
          : sigPairs.map((p) => React.createElement('span', { key: p[0], style: { ...S.chip, whiteSpace: 'nowrap' } },
              p[1] + ' ' + sig[p[0]]))
      );

      // 冷启动引导（产品评审 2026-10-28 P0-1）：账本技能没装 / 里面没规则时，
      // 陌生人的第一屏原来是一根指认他做错事的红条 + 「规则库 0 条」，页面上没有任何按钮能修好它。
      // 现在改出引导卡：说清「本插件不生产规则」+ 三步 + 可复制的 AGENTS.md 片段。
      const onboard = !needsOnboard ? null : React.createElement('div', { style: S.onboard },
        React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' } },
          React.createElement('span', { style: { ...S.dot, background: 'var(--dsw-alias-label-secondary)' }, 'aria-hidden': 'true' }),
          React.createElement('span', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } },
            ledgerStatus === 'missing' ? t('onboardTitleMissing') : t('onboardTitleEmpty'))
        ),
        React.createElement('span', { style: S.dim }, t('onboardBody')),
        React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
          React.createElement('span', null, t('onboardStep1')),
          React.createElement('span', null, t('onboardStep2')),
          React.createElement('span', null, t('onboardStep3'))
        ),
        React.createElement('div', { style: S.snippetRow },
          React.createElement('code', { style: S.snippet }, t('onboardSnippet')),
          React.createElement('button', {
            type: 'button', style: S.btn,
            onClick: (e) => {
              const btn = e.currentTarget;
              const done = () => { btn.textContent = t('onboardCopied'); };
              try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                  navigator.clipboard.writeText(t('onboardSnippet')).then(done, () => {});
                }
              } catch (error) { /* 剪贴板不可用时不影响阅读 */ }
            }
          }, t('onboardCopy'))
        ),
        React.createElement('span', { style: { ...S.mono, whiteSpace: 'normal', overflowWrap: 'anywhere' } },
          t('onboardDir') + '：' + (data.ledgerDir || '-'))
      );

      // 首屏状态：四态（UX 评审 —— 两态文案要覆盖四种语义，会让 3 种状态说错话、1 种与下方卡片同屏矛盾）
      //   unobserved  : 插件从没观测到该会话        → 不在监视范围内（中性灰，且明确说明原因）
      //   no-activity : calls === 0                 → 本会话还没开始（中性灰）
      //   not-checked : calls > 0, q === 0          → 跑过工具没查账本（红）
      //   checked     : queries > 0                 → 已查账本（绿）
      const calls = cur === null ? 0 : (cur.calls || 0);
      // 账本没装/没规则时不能判红：那不是用户做错了事，是「还没有账本可查」。
      // 判红只在「有账本可查却一次没查」时成立（产品评审 2026-10-28）。
      const phase = unobserved ? 'unobserved'
        : (needsOnboard && calls > 0 && (cur === null || cur.queries === 0)) ? 'no-ledger'
        : (cur === null || calls === 0 ? 'no-activity' : (cur.queries > 0 ? 'checked' : 'not-checked'));
      const spineColor = phase === 'checked'
        ? 'var(--dsw-alias-state-success-primary)'
        : phase === 'not-checked' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-border-l3)';
      const headText = phase === 'checked' ? t('statusOn')
        : phase === 'not-checked' ? t('statusOff')
        : phase === 'no-ledger' ? t('onboardTitleMissing').split('——')[0].trim()
        : phase === 'unobserved' ? t('unobserved') : t('statusIdle');
      const headHint = phase === 'checked' ? t('statusOnHint')
        : phase === 'not-checked' ? t('statusOffHint')
        : phase === 'no-ledger' ? t('onboardBody')
        : phase === 'unobserved' ? t('unobservedShort') : t('statusIdleHint');
      // 有引导卡、或本会话根本没被观测到时不出指示灯：那时结论脊与下方那张卡说的是同一句话
      // （评审 B7 / N6：逐字重复，且「不在监视范围内」会出现两遍）。
      // 脊里也不再放 session id 与「最近动作」：前者我在这个会话里用不上，
      // 后者与事件首行重复、且失败调用不更新会与首行自相矛盾。
      const indicator = (needsOnboard || unobserved) ? null : React.createElement('div', {
        style: { ...S.spine, borderLeftColor: spineColor },
        role: 'status', 'aria-live': 'polite'
      },
        React.createElement('div', { style: S.spineMain },
          React.createElement('span', { style: { fontWeight: 600, fontSize: '15px' } }, headText),
          React.createElement('span', { style: S.dim }, headHint)
        ),
        unobserved ? null : React.createElement('div', { style: S.spineSub },
          // 没观测到就没有结论可言：这里显示「还没开始」是错误陈述（它不是没开始，是没被看到）
          React.createElement(Verdict, { t: t, verdict: curVerdict })
        )
      );
      // 推动：踩了坑却零记录 —— 收尾必须补记
      const writeWarn = (data.writeFailures || 0) > 0
        ? React.createElement('div', { style: { ...S.banner, borderColor: 'var(--dsw-alias-state-warn-primary)' }, role: 'alert' },
            React.createElement('span', { style: { ...S.dot, background: 'var(--dsw-alias-state-warn-primary)' }, 'aria-hidden': 'true' }),
            React.createElement('span', null, t('writeWarn').replace('{n}', String(data.writeFailures))))
        : null;
      const needRecord = cur !== null && cur.needRecord === true
        ? React.createElement('div', { style: { ...S.banner, borderColor: 'var(--dsw-alias-state-warn-primary)' }, role: 'alert' },
            React.createElement('span', { style: { ...S.dot, background: 'var(--dsw-alias-state-warn-primary)' }, 'aria-hidden': 'true' }),
            React.createElement('span', null, t('needRecord').replace('{why}', String(cur.needRecordSignals || t('none')))))
        : null;

      // 渲染顺序即叙事顺序（产品评审 2026-10-28）：
      //   冷启动引导（只在没账本/没规则时）→ 指示灯 → 推动横幅 → 工具行 → 五类信号常显
      //   → 指标 / 空态 → 事件 → 其它会话 → 页脚
      // 原来有 10 个同级视觉块用同一个 16px gap 排开、没有分组：引导卡插在指示灯之前，
      // 因为它是唯一能改变首屏结局的东西；信号行紧贴指标，因为它解释指标为什么长这样。
      return React.createElement('div', { style: { ...S.page, ...(state.status === 'stale' ? { opacity: 0.7 } : {}) }, role: 'tabpanel' },
        header, onboard, indicator, writeWarn, bar, needRecord, signalsRow,
        // 引导态下不再叠加空态卡（同一件事说两遍）
        needsOnboard ? null : (cur === null ? emptyCard : kpis),
        eventsCard, othersCard, foot);
    }

    /** 注册界面 + 回报宿主。 */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ledger-watch: dictionaries');
      ctx.effect(() => {
        const style = document.createElement('style');
        style.dataset.plugin = 'dsh-ledger-watch';
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => {
          style.remove();
          viewHolders = 0;                        // 兜底：本插件被卸载时不留残留类
          document.body.classList.remove(VIEW_CLASS);
        };
      }, 'ledger-watch: view css');

      const t = ctx.locale.bind(NS);
      const call = makeCall(ctx);
      const view = (props) => React.createElement(LedgerWatchView, { t: t, call: call, sessionId: props && props.sessionId });
      const pill = (props) => React.createElement(LedgerPill, { t: t, call: call, sessionId: props && props.sessionId });

      let placement = 'ok';
      /**
       * 注册一个座位，并把**会话身份**接进来。
       * 宿主 conversation.view 的 owner props 只有 inspectCall / viewRequest / openView /
       * completeViewRequest 四个回调，没有 sessionId；conversation.composer.dock 更是一个 owner
       * 都没有。原生 trajectory tab 取会话身份的办法就是 register 的 inject(sessionId)。
       * 之前这里读 props.sessionId —— 恒为 undefined，宿主半边于是退回「最近活跃会话」，
       * 把别的会话的数字当本会话显示（2026-10-28 评审 P0）。
       * 万一某个宿主版本不接受 inject，退回无注入注册：tab 仍在，只是如实显示「不在监视范围」，
       * 绝不再顶替成别的会话。
       */
      function seat(slotName, options, component) {
        return ctx.slots.inject(slotName, () => {
          try {
            return ctx.slots.register({ ...options, inject: (sessionId) => ({ sessionId: sessionId }) }, component);
          } catch (error) {
            placement = placement + ';inject-refused:' + slotName + ':' + String((error && error.message) || error);
            return ctx.slots.register(options, component);
          }
        });
      }
      try {
        seat('conversation.view', { name: 'conversation.view', id: 'ledger-watch', order: 30, locale: NS, label: () => t('tab') }, view);
      } catch (error) { placement = 'view-failed:' + String((error && error.message) || error); }
      try {
        seat('conversation.composer.dock', { name: 'conversation.composer.dock', id: 'ledger-watch', order: 5, locale: NS }, pill);
      } catch (error) { placement = placement + ';dock-failed:' + String((error && error.message) || error); }

      try { Promise.resolve(call('report', BUILD, placement)).catch(() => {}); } catch (error) { /* 忽略 */ }
    }

    exports.NS = NS;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
