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

    const BUILD = 'c-2026-10-27 15:20 · clarity-v2';
    const NS = 'settings.ledgerWatch';
    const inject = ['slots', 'locale', 'connection'];
    const REMOTE_METHOD_PARAMS = { state: ['sessionId'], evidence: [], report: ['clientBuild', 'note'] };
    const VIEW_CLASS = 'ledger-watch-view';
    const EVENT_LIMIT = 10;
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
      '.lw-row{border-radius:6px;transition:background-color var(--ds-transition-duration,.2s) var(--ds-ease-in-out,ease-in-out)}',
      '.lw-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.lw-row:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}',
      '.lw-skel{background:var(--dsw-alias-bg-skeleton,var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05)));border-radius:6px;animation:lw-pulse 1.4s ease-in-out infinite}',
      '@keyframes lw-pulse{0%,100%{opacity:1}50%{opacity:.55}}',
      '@media (prefers-reduced-motion: reduce){.lw-skel{animation:none}}'
    ].join('\n');

    const zh = {
      tab: '避坑核对', title: '避坑核对', subtitle: '本会话有没有启用避坑/自我提升（界面只是指示灯，核心是模型真的在查、在记、在改规则）',
      statusOn: '本会话已查经验账本', statusOff: '跑过工具，但没查经验账本', statusIdle: '本会话还没开始',
      statusOnHint: '查过账本，按规矩记录', statusOffHint: '任务已经在动，账本一次没查 —— 先跑 brief.ps1',
      statusIdleHint: '开始给我第一个任务即可；如果我没先查账本，这里会变红',
      diagnostics: '诊断详情', lastChecked: '最近账本活动',
      ledgerLib: '规则库', ledgerEntries: '条', relapse: '失效待改', revised: '已修订',
      recall: '自动召回', adopted: '被引用（推断）', skipped: '跳过', hostBuild: '宿主 build', writeWarn: '证据文件写入失败 {n} 次 —— 面板数据可能停在旧值',
      needRecord: '本会话有 {n} 次失败的工具调用，却一条坑都没记 —— 收尾请用 add-lesson.ps1 补记',
      refresh: '刷新', autoOn: '自动刷新', autoOff: '已暂停', loading: '正在读取监视状态…',
      failed: '读取失败', stale: '数据已过期', retry: '重试', updatedAt: '更新于',
      noSession: '本会话还没有账本相关活动', noSessionHint: '开工先跑 brief.ps1 查询经验，收尾用 add-lesson.ps1 记坑（这两条由我执行）',
      session: '本会话', queries: '查询', records: '记录', turns: '轮次', observed: '宿主工具调用（全局）',
      verdict: '结论', lastAction: '最近动作', events: '最近事件', sessions: '其它会话',
      evidence: '证据文件', build: 'build', client: '客户端回报', none: '无', times: '次',
      more: '仅显示', of: '/', copied: '已复制',
      v_ok: '查了也记了', v_queryonly: '查了没记', v_recordnoquery: '记了没先查', v_missingquery: '没查账本', v_idle: '还没开始',
      h_ok: '本会话既查了账本，也记了坑', h_queryonly: '查过账本，但还没有记录新踩的坑',
      h_recordnoquery: '记了坑，但没有先查账本', h_missingquery: '任务已经动过工具，却一次没查账本',
      h_idle: '还没有账本相关活动', a_query: '查询', a_record: '记录', a_touch: '其它',
      legend: '结论：又查又记 ✓ ｜ 查了没记 / 记了没查 ⚠ ｜ 任务已动却一次没查 ✗',
      pill: '避坑', pillHint: '本会话查经验 / 记坑的次数（点上方「避坑核对」看详情）'
    };
    const en = {
      tab: 'Pitfall check', title: 'Pitfall check', subtitle: 'Whether this session enabled the self-improvement loop (the UI is only an indicator)',
      statusOn: 'Ledger checked in this session', statusOff: 'Tools ran, but the ledger was never checked', statusIdle: 'Nothing happened in this session yet',
      statusOnHint: 'consulted, and recorded by the rules', statusOffHint: 'the session is working but never looked it up - run brief.ps1 first',
      statusIdleHint: 'give me a first task; if I skip the ledger, this turns red',
      diagnostics: 'Diagnostics', lastChecked: 'Last ledger activity',
      ledgerLib: 'Rule base', ledgerEntries: 'entries', relapse: 'needs rework', revised: 'revised',
      recall: 'Auto-recall', adopted: 'adopted', skipped: 'skipped', hostBuild: 'Host build', writeWarn: 'Evidence writes failed {n} times - the panel may be showing stale data',
      needRecord: 'This session had {n} failed tool calls but recorded nothing - run add-lesson.ps1 before finishing',
      refresh: 'Refresh', autoOn: 'Auto', autoOff: 'paused', loading: 'Reading watch state…',
      failed: 'Failed to read', stale: 'stale', retry: 'Retry', updatedAt: 'updated',
      noSession: 'No ledger activity captured yet', noSessionHint: 'Run brief.ps1 to look up, add-lesson.ps1 to record',
      session: 'This session', queries: 'Queries', records: 'Records', turns: 'Turns', observed: 'Host tool calls (global)',
      verdict: 'Verdict', lastAction: 'Last action', events: 'Recent events', sessions: 'Other sessions',
      evidence: 'Evidence file', build: 'build', client: 'Client report', none: 'none', times: '', more: 'showing', of: '/', copied: 'copied',
      v_ok: 'checked + logged', v_queryonly: 'checked only', v_recordnoquery: 'logged, no check', v_missingquery: 'never checked', v_idle: 'not started',
      h_ok: 'Both looked up and recorded', h_queryonly: 'Looked up, nothing recorded yet',
      h_recordnoquery: 'Recorded without looking up first', h_missingquery: 'Tools ran but the ledger was never consulted',
      h_idle: 'No ledger activity yet', a_query: 'query', a_record: 'record', a_touch: 'other',
      legend: 'ok ✓ ｜ query-only / record-no-query ⚠ ｜ activity without a lookup ✗',
      pill: 'pitfalls', pillHint: 'Ledger lookups / pitfall records for this session'
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
        display: 'grid', gridTemplateColumns: '82px 68px minmax(0, 1fr)', gap: '10px', alignItems: 'baseline',
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

      const header = React.createElement('div', { style: S.head },
        React.createElement('h2', { style: S.title }, t('title')),
        React.createElement('p', { style: S.subtitle }, t('subtitle'))
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
          React.createElement('span', { style: S.pill }, t('hostBuild') + '：' + (data.build || '-'))
        )
          )
        );
      }

      const cur = isPlainObject(data.current) ? data.current : null;
      const curVerdict = cur ? cur.verdict : 'idle';
      const evAll = cur && Array.isArray(cur.events) ? cur.events : [];
      const others = Array.isArray(data.sessions) ? data.sessions.filter((s) => !cur || s.id !== cur.id) : [];

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
        React.createElement('span', { style: S.spacer }),
        state.at ? React.createElement('span', { style: S.pill }, t('updatedAt') + ' ' + clockOf(new Date(state.at).toISOString())) : null
      );

      // 状态行卡已删除：结论改由状态脊承担，避免同一结论在一屏里渲染两遍（UI + UX 评审一致）

      const kpis = React.createElement('div', { style: S.kpis },
        React.createElement(Kpi, { label: t('queries'), value: cur ? cur.queries : 0, unit: t('times') }),
        React.createElement(Kpi, { label: t('records'), value: cur ? cur.records : 0, unit: t('times') }),
        React.createElement(Kpi, { label: t('turns'), value: cur ? cur.turns : 0, unit: t('times') })
      );

      const eventsCard = evAll.length === 0 ? null : React.createElement('div', { style: S.card },
        React.createElement('span', { style: S.sectionLabel }, t('events')),
        React.createElement('div', { style: S.rows },
          evAll.slice(0, EVENT_LIMIT).map((ev, i) => React.createElement('div', {
            key: (ev.at || '') + '-' + (ev.tool || '') + '-' + i,
            className: 'lw-row', tabIndex: 0, style: S.evRow, title: fullTime(ev.at) + (ev.basis ? '　·　依据：' + ev.basis : '')
          },
            React.createElement('span', { style: S.time }, clockOf(ev.at)),
            React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '5px', minWidth: 0, overflow: 'hidden' } },
              React.createElement('span', { style: { ...S.dot, background: ev.action === 'record' ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))' }, 'aria-hidden': 'true' }),
              React.createElement('span', { style: { ...S.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: ev.tool || '' }, ev.tool || actionLabel(t, ev.action))
            ),
            React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, ev.label || '')
          )),
          evAll.length > EVENT_LIMIT
            ? React.createElement('span', { style: { ...S.dim, fontSize: '11px', paddingTop: '2px' } }, t('more') + ' ' + EVENT_LIMIT + t('of') + evAll.length)
            : null
        )
      );

      const othersCard = others.length === 0 ? null : React.createElement('div', { style: S.card },
        React.createElement('span', { style: S.sectionLabel }, t('sessions')),
        React.createElement('div', { style: S.rows },
          others.slice(0, SESSION_LIMIT).map((s, i) => React.createElement('div', {
            key: (s.id || '') + '-' + i, className: 'lw-row', tabIndex: 0, style: S.sessRow, title: s.id
          },
            React.createElement(Verdict, { t: t, verdict: s.verdict }),
            React.createElement('span', { style: S.mono }, shortId(s.id)),
            React.createElement('span', { style: { ...S.dim, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } }, t('queries') + ' ' + s.queries + ' · ' + t('records') + ' ' + s.records),
            React.createElement('span', { style: S.time, title: fullTime(s.lastAt) }, clockOf(s.lastAt))
          )),
          others.length > SESSION_LIMIT
            ? React.createElement('span', { style: { ...S.dim, fontSize: '11px', paddingTop: '2px' } }, t('more') + ' ' + SESSION_LIMIT + t('of') + others.length)
            : null
        )
      );

      const emptyCard = cur === null ? React.createElement('div', { style: S.empty },
        React.createElement('span', { style: { fontWeight: 500, color: 'var(--dsw-alias-label-primary)' } }, t('noSession')),
        React.createElement('span', null, t('noSessionHint')),
        React.createElement('span', null,
          React.createElement('span', { style: S.chip }, 'brief.ps1'), ' ', React.createElement('span', { style: S.chip }, 'add-lesson.ps1'))
      ) : null;

      // 页脚：常态只留一行（规则库健康度 = 唯一带行动含义的次要信息），诊断信息折叠起来
      const foot = React.createElement('div', { style: S.foot },
        data.ledger ? React.createElement('span', null, t('ledgerLib') + '：' + data.ledger.entries + t('ledgerEntries') +
          (data.ledger.relapse > 0 ? '　·　' + t('relapse') + ' ' + data.ledger.relapse : '') +
          (data.ledger.revised > 0 ? '　·　' + t('revised') + ' ' + data.ledger.revised : '') +
          (data.ledger.error ? '（' + data.ledger.error + '）' : '')) : null,
        (data.recalls || 0) > 0
          ? React.createElement('span', null, t('recall') + '：' + data.recalls + '　·　' + t('adopted') + ' ' + (data.recallCitedIds || 0))
          : null,
        React.createElement('span', { style: S.spacer }),
        React.createElement('details', { style: S.details },
          React.createElement('summary', { style: { cursor: 'pointer' } }, t('diagnostics')),
          React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', paddingTop: '4px' } },
            React.createElement('span', null, t('client') + '：' + (data.client ? data.client.build + ' · ' + data.client.note + ' · ' + clockOf(data.client.at) : t('none'))),
            React.createElement('span', { style: S.mono }, t('hostBuild') + '：' + (data.build || '-')),
            React.createElement('span', null, t('observed') + '：' + (data.observedToolCalls || 0)),
            React.createElement('span', { style: { ...S.mono, whiteSpace: 'normal', overflowWrap: 'anywhere' } }, t('evidence') + '：' + (data.evidencePath || '-'))
          )
        )
      );

      // 首屏状态：三态（UX 评审 —— 两态文案要覆盖四种语义，会让 3 种状态说错话、1 种与下方卡片同屏矛盾）
      //   no-activity : calls === 0        → 本会话还没开始（中性灰）
      //   not-checked : calls > 0, q === 0 → 跑过工具没查账本（红）
      //   checked     : queries > 0        → 已查账本（绿）
      const calls = cur === null ? 0 : (cur.calls || 0);
      const phase = cur === null || calls === 0 ? 'no-activity' : (cur.queries > 0 ? 'checked' : 'not-checked');
      const spineColor = phase === 'checked'
        ? 'var(--dsw-alias-state-success-primary)'
        : phase === 'not-checked' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-border-l3)';
      const headText = phase === 'checked' ? t('statusOn') : phase === 'not-checked' ? t('statusOff') : t('statusIdle');
      const headHint = phase === 'checked' ? t('statusOnHint') : phase === 'not-checked' ? t('statusOffHint') : t('statusIdleHint');
      const indicator = React.createElement('div', {
        style: { ...S.spine, borderLeftColor: spineColor },
        role: 'status', 'aria-live': 'polite'
      },
        React.createElement('div', { style: S.spineMain },
          React.createElement('span', { style: { fontWeight: 600, fontSize: '15px' } }, headText),
          React.createElement('span', { style: S.dim }, headHint)
        ),
        React.createElement('div', { style: S.spineSub },
          React.createElement(Verdict, { t: t, verdict: curVerdict }),
          cur === null ? null : React.createElement('span', { style: { ...S.mono, maxWidth: '220px' }, title: cur.id }, shortId(cur.id)),
          React.createElement('span', { style: S.dim }, t('lastAction') + '：' + (cur && cur.lastLabel ? cur.lastLabel : t('none')))
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
            React.createElement('span', null, t('needRecord').replace('{n}', String(cur.failures))))
        : null;

      return React.createElement('div', { style: { ...S.page, ...(state.status === 'stale' ? { opacity: 0.7 } : {}) }, role: 'tabpanel' },
        header, indicator, writeWarn, bar, needRecord, cur === null ? emptyCard : kpis, eventsCard, othersCard, foot);
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
      try {
        ctx.slots.inject('conversation.view', () =>
          ctx.slots.register({ name: 'conversation.view', id: 'ledger-watch', order: 30, locale: NS, label: () => t('tab') }, view)
        );
      } catch (error) { placement = 'view-failed:' + String((error && error.message) || error); }
      try {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({ name: 'conversation.composer.dock', id: 'ledger-watch', order: 5, locale: NS }, pill)
        );
      } catch (error) { placement = placement + ';dock-failed:' + String((error && error.message) || error); }

      try { Promise.resolve(call('report', BUILD, placement)).catch(() => {}); } catch (error) { /* 忽略 */ }
    }

    exports.NS = NS;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
