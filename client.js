window.__ModuleLoader__.load({
  id: '@local/dsh-resmon',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef } = React;

    /* ------------------------------------------------------------------ *
     * Tiny observable stores shared by the tracker seat and the panel     *
     * ------------------------------------------------------------------ */
    function makeStore(initial) {
      let value = initial;
      const listeners = new Set();
      return {
        get: () => value,
        set(next) {
          if (Object.is(value, next)) return;
          value = next;
          for (const fn of [...listeners]) fn();
        },
        subscribe(fn) {
          listeners.add(fn);
          return () => {
            listeners.delete(fn);
          };
        },
      };
    }

    const sessionStore = makeStore(undefined); // current viewed sessionId
    const localeTick = makeStore(0);

    function useTracked(store) {
      const [value, setValue] = useState(store.get);
      useEffect(() => store.subscribe(() => setValue(store.get())), [store]);
      return value;
    }

    /* ------------------------------------------------------------------ *
     * Formatting helpers                                                  *
     * ------------------------------------------------------------------ */
    function fmtPercent(n) {
      if (n == null || !isFinite(n)) return '—';
      return `${Math.round(n)}%`;
    }

    function fmtPercent1(n) {
      if (n == null || !isFinite(n)) return '—';
      return `${Number(n).toFixed(1)}%`;
    }

    function fmtBytes(n) {
      if (n == null || !isFinite(n)) return '—';
      if (n >= 1073741824) return `${(n / 1073741824).toFixed(1)} GB`;
      if (n >= 1048576) return `${(n / 1048576).toFixed(0)} MB`;
      return `${(n / 1024).toFixed(0)} KB`;
    }

    function fmtGb1(n) {
      if (n == null || !isFinite(n)) return '—';
      return (n / 1073741824).toFixed(1);
    }

    function fmtBps(n) {
      if (n == null || !isFinite(n)) return '—';
      if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB/s`;
      if (n >= 1024) return `${(n / 1024).toFixed(0)} KB/s`;
      return `${Math.round(n)} B/s`;
    }

    function fmtTokens(n, zh) {
      if (n == null || !isFinite(n)) return '—';
      if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
      if (zh && n >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
      if (zh && n >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
      if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
      if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
      return String(Math.round(n));
    }

    function fmtUptime(sec) {
      if (sec == null || !isFinite(sec)) return '—';
      const d = Math.floor(sec / 86400);
      const hr = Math.floor((sec % 86400) / 3600);
      const mi = Math.floor((sec % 3600) / 60);
      if (d > 0) return `${d}d ${hr}h`;
      if (hr > 0) return `${hr}h ${mi}m`;
      return `${mi}m`;
    }

    function fmtCost(n) {
      if (n == null || !isFinite(n)) return '—';
      return `¥${n < 0.01 ? Number(n).toFixed(4) : Number(n).toFixed(2)}`;
    }

    function fmtPrice(n) {
      if (n == null || !isFinite(n)) return '—';
      const value = Number(n);
      return Number.isInteger(value) ? value.toFixed(1) : String(value);
    }

    /* ------------------------------------------------------------------ *
     * Sparkline graph (Task-Manager style)                                *
     * ------------------------------------------------------------------ */
    function Sparkline({ data, color }) {
      const w = 100;
      const height = 26;
      if (!data || data.length < 2) return h('div', { style: { height: 20 } });
      const max = Math.max(5, ...data);
      const pts = data
        .map((v, i) => {
          const x = (i / (data.length - 1)) * w;
          const y = height - Math.min(1, Math.max(0, v / max)) * (height - 3) - 1.5;
          return `${x.toFixed(2)},${y.toFixed(2)}`;
        })
        .join(' ');
      return h(
        'svg',
        { viewBox: `0 0 ${w} ${height}`, preserveAspectRatio: 'none', style: { width: '100%', height: 22, display: 'block' } },
        h('polygon', { points: `0,${height} ${pts} ${w},${height}`, style: { fill: color, opacity: 0.14 } }),
        h('polyline', { points: pts, style: { fill: 'none', stroke: color, strokeWidth: 1.6 } }),
      );
    }

    /* ------------------------------------------------------------------ *
     * Host bridge: two authenticated fetch routes                         *
     * ------------------------------------------------------------------ */
    async function hostFetch(path, payload, signal, method = 'POST') {
      const isGet = method === 'GET';
      const response = await fetch(path, {
        method,
        ...(isGet
          ? {}
          : {
              headers: { 'content-type': 'application/json' },
              body: payload === undefined ? '{}' : JSON.stringify(payload),
            }),
        ...(signal === undefined ? {} : { signal }),
      });
      let body = null;
      try {
        body = await response.json();
      } catch { /* empty or non-JSON body */ }
      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        if (body && body.error) {
          message = typeof body.error === 'object' && body.error !== null
            ? (body.error.message || String(body.error))
            : String(body.error);
        }
        throw new Error(message);
      }
      if (!body || body.ok !== true) throw new Error(body && body.error ? String(body.error) : 'bad response');
      return body.value;
    }

    /* ------------------------------------------------------------------ *
     * Dragging helpers                                                    *
     * ------------------------------------------------------------------ */
    function clampPos(x, y, w, h) {
      const maxX = Math.max(0, (window.innerWidth || 1280) - w - 4);
      const maxY = Math.max(0, (window.innerHeight || 800) - h - 4);
      return {
        x: Math.max(0, Math.min(x, maxX)),
        y: Math.max(0, Math.min(y, maxY)),
      };
    }

    /**
     * Pointer handlers that make the card/pill draggable. A press without
     * movement counts as a tap (`onTap`), so the pill can both drag and
     * expand.
     */
    function dragHandlers(onMoved, onTap) {
      return {
        onPointerDown(event) {
          if (event.button !== 0) return;
          const handle = event.currentTarget;
          const card = handle.closest('.drm-card, .drm-pill');
          const root = handle.closest('.drm-root');
          if (!card || !root) return;
          const rect = card.getBoundingClientRect();
          const sx = event.clientX;
          const sy = event.clientY;
          const sl = rect.left;
          const st = rect.top;
          let moved = false;
          const onMove = (ev) => {
            if (!moved && Math.abs(ev.clientX - sx) < 4 && Math.abs(ev.clientY - sy) < 4) return;
            moved = true;
            const p = clampPos(sl + ev.clientX - sx, st + ev.clientY - sy, rect.width, rect.height);
            root.style.left = `${p.x}px`;
            root.style.top = `${p.y}px`;
            root.style.bottom = 'auto';
          };
          const onUp = (ev) => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            if (moved) {
              onMoved(clampPos(sl + ev.clientX - sx, st + ev.clientY - sy, rect.width, rect.height));
            } else if (onTap) {
              onTap();
            }
          };
          window.addEventListener('pointermove', onMove);
          window.addEventListener('pointerup', onUp);
        },
      };
    }

    /* ------------------------------------------------------------------ *
     * Session tracker seat: learns the viewed sessionId from a            *
     * session-scoped slot and shares it with the overlay panel.           *
     * ------------------------------------------------------------------ */
    function SessionTracker(props) {
      const sessionId = props && props.sessionId;
      useEffect(() => {
        sessionStore.set(sessionId);
      }, [sessionId]);
      return null;
    }

    /* ------------------------------------------------------------------ *
     * The draggable bottom-left panel                                     *
     * ------------------------------------------------------------------ */
    const METRICS = [
      ['turn', 'thisTurn'],
      ['session', 'thisSession'],
      ['today', 'today'],
      ['cumulative', 'total'],
    ];

    const TOKENS = [
      { key: 'input', label: 'input' },
      { key: 'output', label: 'output' },
      { key: 'total', label: 'sum' },
    ];

    const SCOPES = [
      ['machine', 'scopeMachine'],
      ['dsh', 'scopeDsh'],
    ];

    const ITEM_DEFS = [
      { id: 'cpu', key: 'itemCpu', color: 'var(--dsw-alias-brand-primary)' },
      { id: 'mem', key: 'itemMem', color: 'var(--dsw-alias-state-success-primary)' },
      { id: 'disk', key: 'itemDisk', color: 'var(--dsw-alias-state-warn-primary)' },
      { id: 'dshsize', key: 'itemDshSize', color: null },
      { id: 'net', key: 'itemNet', color: 'var(--dsw-alias-state-idle-primary)' },
      { id: 'gpu', key: 'itemGpu', color: 'var(--dsw-alias-state-error-primary)' },
      { id: 'tokens', key: 'itemTokens', color: null },
      { id: 'cost', key: 'itemCost', color: null },
    ];

    function Panel({ t, getLocale }) {
      const sessionId = useTracked(sessionStore);
      useTracked(localeTick); // re-render when the locale switches
      const [stats, setStats] = useState(null);
      const [usage, setUsage] = useState(null);
      const [metric, setMetric] = useState(() => {
        try {
          return localStorage.getItem('dsh-resmon.metric') || 'session';
        } catch {
          return 'session';
        }
      });
      const [scope, setScope] = useState(() => {
        try {
          return localStorage.getItem('dsh-resmon.scope') === 'dsh' ? 'dsh' : 'machine';
        } catch {
          return 'machine';
        }
      });
      const [collapsed, setCollapsed] = useState(() => {
        try {
          return localStorage.getItem('dsh-resmon.collapsed') === '1';
        } catch {
          return false;
        }
      });
      const [pos, setPos] = useState(() => {
        try {
          const raw = localStorage.getItem('dsh-resmon.pos');
          if (raw) {
            const p = JSON.parse(raw);
            if (typeof p.x === 'number' && typeof p.y === 'number') return p;
          }
        } catch { /* ignore */ }
        return null;
      });
      const [items, setItems] = useState(() => {
        try {
          const raw = localStorage.getItem('dsh-resmon.items');
          if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
              const known = new Set(ITEM_DEFS.map((def) => def.id));
              return parsed.filter((id) => known.has(id));
            }
          }
        } catch { /* ignore */ }
        return [];
      });
      const [menuOpen, setMenuOpen] = useState(false);
      const rootRef = useRef(null);
      const posRef = useRef(pos);
      posRef.current = pos;
      const lastPanelRevRef = useRef(null);
      if (lastPanelRevRef.current === null) {
        try {
          const n = Number(localStorage.getItem('dsh-resmon.panelRev'));
          lastPanelRevRef.current = isFinite(n) && n > 0 ? n : 0;
        } catch {
          lastPanelRevRef.current = 0;
        }
      }

      useEffect(() => {
        let alive = true;
        const controller = new AbortController();
        let busy = false;
        const poll = async () => {
          if (busy || !alive) return;
          busy = true;
          try {
            const statsValue = await hostFetch('/api/dsh-resmon/stats', undefined, controller.signal);
            setStats(statsValue);
            const usageValue = await hostFetch('/api/dsh-resmon/usage', { sessionId }, controller.signal);
            setUsage(usageValue);
          } catch (error) {
            /* Host restarting or channel not up yet — keep last values. */
          }
          busy = false;
        };
        poll();
        const id = setInterval(poll, 1000);
        return () => {
          alive = false;
          controller.abort();
          clearInterval(id);
        };
      }, [sessionId]);

      const commitPos = (p) => {
        setPos(p);
        try {
          localStorage.setItem('dsh-resmon.pos', JSON.stringify(p));
        } catch { /* storage unavailable */ }
      };

      /**
       * Pull the card/pill back into the viewport when it sits outside
       * (e.g. the window shrank while the panel was dragged elsewhere).
       * No-op while pos is null (bottom-right anchored default).
       */
      const clampNow = () => {
        const current = posRef.current;
        if (!current || !rootRef.current) return;
        const card = rootRef.current.querySelector('.drm-card, .drm-pill');
        if (!card) return;
        const rect = card.getBoundingClientRect();
        const next = clampPos(rect.left, rect.top, rect.width, rect.height);
        if (next.x !== rect.left || next.y !== rect.top) {
          rootRef.current.style.left = `${next.x}px`;
          rootRef.current.style.top = `${next.y}px`;
          rootRef.current.style.bottom = 'auto';
          commitPos(next);
        }
      };

      useEffect(() => {
        let timer = null;
        const onResize = () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            timer = null;
            clampNow();
          }, 150);
        };
        window.addEventListener('resize', onResize);
        return () => {
          if (timer) clearTimeout(timer);
          window.removeEventListener('resize', onResize);
        };
      }, []);

      useEffect(() => {
        clampNow();
      }, [collapsed, items]);

      const toggleCollapsed = () => {
        setMenuOpen(false);
        setCollapsed((current) => {
          const next = !current;
          try {
            localStorage.setItem('dsh-resmon.collapsed', next ? '1' : '0');
          } catch { /* storage unavailable */ }
          return next;
        });
      };

      const pickMetric = (key) => {
        setMetric(key);
        try {
          localStorage.setItem('dsh-resmon.metric', key);
        } catch { /* storage unavailable */ }
      };

      const pickScope = (key) => {
        setScope(key);
        try {
          localStorage.setItem('dsh-resmon.scope', key);
        } catch { /* storage unavailable */ }
      };

      const persistItems = (next) => {
        setItems(next);
        try {
          localStorage.setItem('dsh-resmon.items', JSON.stringify(next));
        } catch { /* storage unavailable */ }
      };

      const addItem = (id) => {
        setMenuOpen(false);
        if (items.includes(id)) return;
        persistItems([...items, id]);
      };

      const removeItem = (id) => {
        persistItems(items.filter((itemId) => itemId !== id));
      };

      const applyCollapsed = (value) => {
        setMenuOpen(false);
        setCollapsed(value === true);
        try {
          localStorage.setItem('dsh-resmon.collapsed', value === true ? '1' : '0');
        } catch { /* storage unavailable */ }
      };

      /**
       * Applies an external panel command (from /api/dsh-resmon/panel).
       * Only valid fields are applied, so the UI changes exactly as if the
       * user had clicked the corresponding controls.
       */
      const applyPanelCommand = (command) => {
        if (!command || typeof command !== 'object') return;
        if (Array.isArray(command.items)) {
          const known = new Set(ITEM_DEFS.map((def) => def.id));
          const filtered = [...new Set(command.items.filter((id) => known.has(id)))];
          persistItems(filtered);
        }
        if (typeof command.collapsed === 'boolean') applyCollapsed(command.collapsed);
        if (command.scope === 'machine' || command.scope === 'dsh') pickScope(command.scope);
        if (command.metric === 'turn' || command.metric === 'session' || command.metric === 'today' || command.metric === 'cumulative') pickMetric(command.metric);
      };

      // Poll the external panel-command channel and apply newer revisions.
      useEffect(() => {
        let alive = true;
        const controller = new AbortController();
        const pollPanel = async () => {
          if (!alive) return;
          try {
            const value = await hostFetch('/api/dsh-resmon/panel', undefined, controller.signal);
            const revision = value && value.revision;
            if (typeof revision === 'number' && revision > lastPanelRevRef.current) {
              applyPanelCommand(value.command);
              lastPanelRevRef.current = revision;
              try {
                localStorage.setItem('dsh-resmon.panelRev', String(revision));
              } catch { /* storage unavailable */ }
            }
          } catch { /* route not ready yet or host restarting */ }
        };
        pollPanel();
        const id = setInterval(pollPanel, 2000);
        return () => {
          alive = false;
          controller.abort();
          clearInterval(id);
        };
      }, []);

      const isZh = String(getLocale() || '').toLowerCase().startsWith('zh');
      const cpu = stats ? stats.cpu : null;
      const mem = stats ? stats.mem : null;
      const system = stats ? stats.system : null;
      const dsh = stats ? stats.dsh : null;
      const disk = stats && Array.isArray(stats.disk) ? stats.disk : null;
      const dshsize = stats ? stats.dshsize : null;
      const net = stats ? stats.net : null;
      const gpu = stats ? stats.gpu : null;
      const cost = usage && usage.cost ? usage.cost : null;
      const official = usage && usage.official ? usage.official : null;
      const isDsh = scope === 'dsh';
      const netAvail = !!(net && net.available === true);
      const gpuAvail = !!(gpu && gpu.available === true);

      const cpuValue = isDsh ? (dsh ? dsh.cpu : null) : cpu;
      const cpuHistory = isDsh
        ? (dsh ? dsh.history.cpu : null)
        : (stats ? stats.history.cpu : null);
      const memHistory = isDsh
        ? (dsh ? dsh.history.mem : null)
        : (stats ? stats.history.mem : null);
      const memText = isDsh
        ? (dsh && mem
          ? `${fmtBytes(dsh.mem.rss)} / ${fmtBytes(mem.total)} (${fmtPercent(mem.total > 0 ? (dsh.mem.rss / mem.total) * 100 : 0)})`
          : '—')
        : (mem ? `${fmtBytes(mem.used)} / ${fmtBytes(mem.total)} (${fmtPercent(mem.percent)})` : '—');
      const pillMemText = isDsh
        ? (dsh ? fmtBytes(dsh.mem.rss) : '—')
        : (mem ? fmtPercent(mem.percent) : '—');

      let current = null;
      if (usage) {
        if (metric === 'turn') current = usage.session ? usage.session.turn : null;
        else if (metric === 'today') current = usage.today;
        else if (metric === 'cumulative') current = usage.cumulative;
        else current = usage.session;
      }

      const metricChips = () => METRICS.map(([key, label]) => h(
        'button',
        {
          key,
          type: 'button',
          className: `drm-chip${metric === key ? ' drm-chip-active' : ''}`,
          onClick: () => pickMetric(key),
          title: t(`${label}Title`),
        },
        t(label),
      ));

      const scopeChips = SCOPES.map(([key, label]) => h(
        'button',
        {
          key,
          type: 'button',
          className: `drm-chip drm-scope-chip${scope === key ? ' drm-chip-active' : ''}`,
          onClick: () => pickScope(key),
          title: t(`${label}Title`),
        },
        t(label),
      ));

      const tokenLines = TOKENS.map(({ key, label }) => h(
        'div',
        { key, className: 'drm-line' },
        h('span', { className: 'drm-label' }, t(label)),
        h('span', { className: 'drm-value' }, current ? fmtTokens(current[key], isZh) : '—'),
      ));

      const officialTodayPlatform = !!(official && official.todayCost != null);
      const officialWhaleToday = !!(official && official.whaleToday != null);
      const officialWhaleCumulative = !!(official && official.whaleCumulative != null);
      const officialToday = !!(official && official.source != null && official.todayUsed != null);

      const costValueFor = (key) => {
        if (key === 'today') {
          if (officialTodayPlatform) return official.todayCost;
          if (officialWhaleToday) return official.whaleToday;
          if (officialToday) return official.todayUsed;
        }
        if (key === 'cumulative' && officialWhaleCumulative) return official.whaleCumulative;
        return cost ? cost[key] : null;
      };

      // 费用项不再显示来源标注,仅数值。
      const costLines = METRICS.map(([key, label]) => {
        const value = costValueFor(key);
        return h('div', { key, className: 'drm-line' },
          h('span', { className: 'drm-label' }, t(label)),
          h('span', { className: 'drm-value' }, fmtCost(value)));
      });

      const balanceLine = official && official.balance
        ? h('div', { className: 'drm-line' },
            h('span', { className: 'drm-label' }, t('officialBalance')),
            h('span', { className: 'drm-value' }, fmtCost(official.balance.total)))
        : null;

      const monthLine = official && official.monthCost != null
        ? h('div', { className: 'drm-line' },
            h('span', { className: 'drm-label' }, t('officialMonth')),
            h('span', { className: 'drm-value' }, fmtCost(official.monthCost)))
        : null;

      const reviewLine = official && official.needsReview === true
        ? h('div', { className: 'drm-warn' }, t('needsReview'))
        : null;

      const officialNoteLine = h('div', { className: 'drm-official-note' },
        h('a', {
          href: (official && official.usageUrl) || 'https://platform.deepseek.com/',
          target: '_blank',
          rel: 'noreferrer',
        }, t('officialNote')));

      const pricingText = (() => {
        if (!cost || !cost.model || !cost.prices) return '—';
        const prices = cost.prices || {};
        const segments = [String(cost.model)];
        const period = cost.period;
        if (period) {
          segments.push(
            period === 'peak' ? t('periodPeak')
              : period === 'offpeak' ? t('periodOffpeak')
                : String(period),
          );
        }
        const effort = cost.reasoningEffort;
        if (effort) {
          segments.push(
            effort === 'high' ? t('reasoningHigh')
              : effort === 'medium' ? t('reasoningMedium')
                : effort === 'low' ? t('reasoningLow')
                  : String(effort),
          );
        }
        segments.push(`${t('costIn')} ¥${fmtPrice(prices.input)} / ${t('costOut')} ¥${fmtPrice(prices.output)} ${t('costPerM')}`);
        return segments.join(' · ');
      })();

      const estimatedLine = cost && cost.running === true && cost.estimatedTurn != null
        ? h('div', { className: 'drm-line' },
            h('span', { className: 'drm-label' }, t('costEstimated')),
            h('span', { className: 'drm-value' }, fmtCost(cost.estimatedTurn)))
        : null;

      const itemSection = (id, title, children, extraHead) => h(
        'div',
        { key: id, className: 'drm-section' },
        h('div', { className: 'drm-section-head' },
          h('span', { className: 'drm-section-title' }, title),
          extraHead || null,
          h('button', {
            type: 'button',
            className: 'drm-remove',
            onClick: () => removeItem(id),
            onPointerDown: (event) => event.stopPropagation(),
            title: t('removeItem'),
            'aria-label': t('removeItem'),
          }, '×')),
        ...children,
      );

      const renderItem = (id) => {
        const def = ITEM_DEFS.find((item) => item.id === id);
        if (!def) return null;
        if (id === 'cpu') {
          return itemSection(id, t('itemCpu'), [
            h('div', { className: 'drm-row' },
              h('span', { className: 'drm-label' }, isDsh ? t('scopeDsh') : t('cpu')),
              h('span', { className: 'drm-value' }, cpuValue == null ? '—' : fmtPercent(cpuValue))),
            h(Sparkline, { data: cpuHistory, color: def.color }),
          ]);
        }
        if (id === 'mem') {
          return itemSection(id, t('itemMem'), [
            h('div', { className: 'drm-row' },
              h('span', { className: 'drm-label' }, t('memory')),
              h('span', { className: 'drm-value' }, memText)),
            h(Sparkline, { data: memHistory, color: def.color }),
          ]);
        }
        if (id === 'disk') {
          const rows = [];
          if (disk && disk.length) {
            disk.forEach((drive) => {
              const active = drive.activePercent;
              rows.push(h('div', { key: drive.drive, className: 'drm-row' },
                h('span', { className: 'drm-label' }, drive.drive),
                h('span', { className: 'drm-value' }, active != null
                  ? `${t('diskActive')} ${fmtPercent1(active)}`
                  : `${fmtPercent1(drive.percent)} · ${t('diskUsed')} ${fmtBytes(drive.used)} / ${fmtBytes(drive.total)}`)));
              if (active != null) {
                rows.push(h('div', { key: `${drive.drive}-sub`, className: 'drm-row drm-sub' },
                  h('span', { className: 'drm-value' },
                    `${t('diskUsed')} ${fmtBytes(drive.used)} / ${fmtBytes(drive.total)} (${fmtPercent1(drive.percent)})`)));
              }
            });
          } else {
            rows.push(h('div', { className: 'drm-row' }, h('span', { className: 'drm-value' }, '—')));
          }
          return itemSection(id, t('itemDisk'), rows);
        }
        if (id === 'dshsize') {
          const sizeRow = (key, labelKey) => h('div', { key: labelKey, className: 'drm-line' },
            h('span', { className: 'drm-label' }, t(labelKey)),
            h('span', { className: 'drm-value' },
              dshsize && dshsize.computing === true && dshsize[key] == null
                ? t('computing')
                : fmtBytes(dshsize ? dshsize[key] : null)));
          return itemSection(id, t('itemDshSize'),
            dshsize
              ? [sizeRow('app', 'dshApp'), sizeRow('home', 'dshHome'), sizeRow('total', 'dshTotal')]
              : [h('div', { className: 'drm-row' }, h('span', { className: 'drm-value' }, '—'))]);
        }
        if (id === 'net') {
          return itemSection(id, t('itemNet'), [
            h('div', { className: 'drm-row' },
              h('span', { className: 'drm-label' }, `${t('netDown')} / ${t('netUp')}`),
              h('span', { className: 'drm-value' }, netAvail
                ? `↓ ${fmtBps(net.downBps)} · ↑ ${fmtBps(net.upBps)}`
                : t('unavailable'))),
            h(Sparkline, { data: netAvail && net.history ? net.history.totalBps : null, color: def.color }),
          ]);
        }
        if (id === 'gpu') {
          return itemSection(id, t('itemGpu'), [
            h('div', { className: 'drm-row' },
              h('span', { className: 'drm-value' }, gpuAvail
                ? (gpu.memTotal != null
                  ? `${fmtPercent1(gpu.util)} · ${t('gpuVram')} ${fmtGb1(gpu.memUsed)}/${fmtGb1(gpu.memTotal)} GB`
                  : `${fmtPercent1(gpu.util)} · ${t('gpuVram')} ${fmtBytes(gpu.memUsed)}`)
                : t('unavailable'))),
            h(Sparkline, { data: gpuAvail && gpu.history ? gpu.history.util : null, color: def.color }),
          ]);
        }
        if (id === 'tokens') {
          return itemSection(id, t('itemTokens'), [
            h('div', { className: 'drm-chips' }, metricChips()),
            h('div', { className: 'drm-lines' }, tokenLines),
          ], sessionId ? null : h('span', { className: 'drm-label' }, `(${t('noSession')})`));
        }
        if (id === 'cost') {
          // 费用项同时展示全部四个口径(本轮/会话/今日/累计),不再提供切换 chips。
          return itemSection(id, t('itemCost'), [
            h('div', { className: 'drm-lines' }, costLines),
            monthLine,
            balanceLine,
            reviewLine,
            h('div', { className: 'drm-line' },
              h('span', { className: 'drm-label' }, t('costPricing')),
              h('span', { className: 'drm-value drm-pricing' }, pricingText)),
            estimatedLine,
            officialNoteLine,
          ]);
        }
        return null;
      };

      const pillValue = (id) => {
        if (id === 'cpu') return { label: null, text: `${isDsh ? 'DSH' : 'CPU'} ${cpuValue == null ? '—' : fmtPercent(cpuValue)}` };
        if (id === 'mem') return { label: t('itemMem'), text: pillMemText };
        if (id === 'disk') {
          const first = disk && disk.length ? disk[0] : null;
          return { label: t('itemDisk'), text: first
            ? (first.activePercent != null
              ? `${first.drive} ${fmtPercent1(first.activePercent)}`
              : `${first.drive} ${fmtPercent1(first.percent)}`)
            : '—' };
        }
        if (id === 'dshsize') {
          return { label: t('itemDshSize'), text: dshsize && dshsize.computing === true && dshsize.total == null
            ? t('computing')
            : fmtBytes(dshsize ? dshsize.total : null) };
        }
        if (id === 'net') return { label: t('itemNet'), text: netAvail ? `↓ ${fmtBps(net.downBps)} · ↑ ${fmtBps(net.upBps)}` : t('unavailable') };
        if (id === 'gpu') return { label: t('itemGpu'), text: gpuAvail ? fmtPercent1(gpu.util) : t('unavailable') };
        if (id === 'tokens') return { label: t('itemTokens'), text: current ? fmtTokens(current.total, isZh) : '—' };
        if (id === 'cost') return { label: t('itemCost'), text: officialTodayPlatform
          ? fmtCost(official.todayCost)
          : officialWhaleToday
            ? fmtCost(official.whaleToday)
            : officialToday
              ? fmtCost(official.todayUsed)
              : officialWhaleCumulative
                ? fmtCost(official.whaleCumulative)
                : fmtCost(cost ? cost.cumulative : null) };
        return { label: null, text: '—' };
      };

      const pillSegments = items.slice(0, 3).map((id) => {
        const { label, text } = pillValue(id);
        return h('span', { key: id }, label ? `${label} ` : null, h('b', null, text));
      });

      const pillBody = [];
      if (items.length === 0) {
        pillBody.push(h('span', null, `${t('title')} · ${t('emptyPill')}`));
      } else {
        pillSegments.forEach((segment, index) => {
          if (index > 0) pillBody.push(h('span', { key: `sep-${index}` }, ' · '));
          pillBody.push(segment);
        });
      }

      const collapsedPill = h(
        'div',
        {
          className: 'drm-pill',
          ...dragHandlers(commitPos, toggleCollapsed),
          role: 'button',
          tabIndex: 0,
          title: t('expand'),
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              toggleCollapsed();
            }
          },
        },
        h('span', { className: 'drm-pill-badge' }, '▸'),
        ...pillBody,
      );

      const unadded = ITEM_DEFS.filter((def) => !items.includes(def.id));
      const addMenu = menuOpen && unadded.length
        ? h('div', { className: 'drm-menu' },
            unadded.map((def) => h('button', {
              type: 'button',
              key: def.id,
              className: 'drm-menu-item',
              onClick: () => addItem(def.id),
            }, `＋ ${t(def.key)}`)))
        : null;
      const addBlock = unadded.length
        ? h('div', { className: 'drm-add' },
            h('button', {
              type: 'button',
              className: 'drm-add-btn',
              onClick: () => setMenuOpen((open) => !open),
            }, `＋ ${t('addItem')}`),
            addMenu)
        : null;

      const showScope = items.includes('cpu') || items.includes('mem');

      const rootStyle = pos
        ? { left: `${pos.x}px`, top: `${pos.y}px` }
        : { left: 12, bottom: 12 };

      if (collapsed) {
        return h(
          'div',
          { ref: rootRef, className: 'drm-root', style: rootStyle },
          h('style', null, PANEL_CSS),
          collapsedPill,
        );
      }

      const body = [];
      if (items.length === 0) {
        body.push(h('div', { className: 'drm-empty' },
          addBlock,
          h('div', { className: 'drm-empty-hint' }, t('emptyPanel'))));
      } else {
        if (showScope) body.push(h('div', { className: 'drm-chips drm-scope' }, scopeChips));
        items.forEach((id) => {
          const rendered = renderItem(id);
          if (rendered) body.push(rendered);
        });
        if (addBlock) body.push(addBlock);
        body.push(h('div', { className: 'drm-foot' },
          h('span', null, system ? system.hostname : ''),
          h('span', null, system ? `${system.osVersion != null ? system.osVersion : system.platform} · ${t('uptime')} ${fmtUptime(system.uptime)}` : '')));
      }

      return h(
        'div',
        { ref: rootRef, className: 'drm-root', style: rootStyle },
        h('style', null, PANEL_CSS),
        h(
          'div',
          { className: 'drm-card' },
          h(
            'div',
            { className: 'drm-header drm-drag', ...dragHandlers(commitPos) },
            h('span', { className: 'drm-title' }, t('title')),
            h(
              'button',
              {
                type: 'button',
                className: 'drm-close',
                onClick: toggleCollapsed,
                onPointerDown: (event) => event.stopPropagation(),
                title: t('collapse'),
                'aria-label': t('collapse'),
              },
              '—',
            ),
          ),
          ...body,
        ),
      );
    }

    /* ------------------------------------------------------------------ *
     * Settings page (settings.section entry, same level as desktop control)*
     * ------------------------------------------------------------------ */
    function normalizeConfig(value) {
      const v = value || {};
      const p = v.pricing || {};
      const pm = p.models || {};
      const o = v.official || {};
      const w = v.whale || {};
      const x = v.external || {};
      const s = v.sampling || {};
      return {
        pricing: {
          offPeakRatio: p.offPeakRatio != null ? String(p.offPeakRatio) : '',
          models: {
            default: typeof pm.default === 'string' ? pm.default : '',
            overrides: typeof pm.overrides === 'string' ? pm.overrides : '',
          },
        },
        official: {
          mode: o.mode === 'apikey' || o.mode === 'account' || o.mode === 'off' || o.mode === 'auto' ? o.mode : 'auto',
          pollSeconds: o.pollSeconds != null ? String(o.pollSeconds) : '',
        },
        whale: {
          enabled: w.enabled === true,
          path: typeof w.path === 'string' ? w.path : '',
        },
        external: {
          enabled: x.enabled === true,
          port: x.port != null ? String(x.port) : '',
        },
        sampling: {
          netGpuSeconds: s.netGpuSeconds != null ? String(s.netGpuSeconds) : '',
          diskSeconds: s.diskSeconds != null ? String(s.diskSeconds) : '',
          dshsizeMinutes: s.dshsizeMinutes != null ? String(s.dshsizeMinutes) : '',
        },
      };
    }

    function SettingsPage({ t }) {
      useTracked(localeTick); // re-render when the locale switches
      const [status, setStatus] = useState('loading'); // loading | ready | error
      const [loadError, setLoadError] = useState('');
      const [draft, setDraft] = useState(null);
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState(null); // { tone: 'ok'|'err', text }
      const [specNotice, setSpecNotice] = useState(null); // { tone: 'ok'|'err', text }

      useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const value = await hostFetch('/api/dsh-resmon/config', undefined, undefined, 'GET');
            if (alive) {
              setDraft(normalizeConfig(value));
              setStatus('ready');
            }
          } catch (error) {
            if (alive) {
              setLoadError(error instanceof Error ? error.message : String(error));
              setStatus('error');
            }
          }
        })();
        return () => {
          alive = false;
        };
      }, []);

      if (status === 'loading') {
        return h('div', { className: 'drs-wrap' },
          h('style', null, SETTINGS_CSS),
          h('div', { className: 'drs-title' }, t('settingsTitle')),
          h('div', { className: 'drs-loading' }, t('sLoading')));
      }
      if (status === 'error') {
        return h('div', { className: 'drs-wrap' },
          h('style', null, SETTINGS_CSS),
          h('div', { className: 'drs-title' }, t('settingsTitle')),
          h('div', { className: 'drs-error' }, `${t('sLoadFailed')}: ${loadError}`));
      }

      const d = draft;
      const patchPricing = (key, value) => setDraft((current) => ({ ...current, pricing: { ...current.pricing, [key]: value } }));
      const patchModels = (key, value) => setDraft((current) => ({ ...current, pricing: { ...current.pricing, models: { ...current.pricing.models, [key]: value } } }));
      const patchOfficial = (key, value) => setDraft((current) => ({ ...current, official: { ...current.official, [key]: value } }));
      const patchWhale = (key, value) => setDraft((current) => ({ ...current, whale: { ...current.whale, [key]: value } }));
      const patchExternal = (key, value) => setDraft((current) => ({ ...current, external: { ...current.external, [key]: value } }));
      const patchSampling = (key, value) => setDraft((current) => ({ ...current, sampling: { ...current.sampling, [key]: value } }));

      const buildPayload = () => {
        const number = (raw) => {
          if (raw === '' || raw == null) return null;
          const n = Number(raw);
          return isFinite(n) ? n : null;
        };
        const pricing = { models: {} };
        if (number(d.pricing.offPeakRatio) != null) pricing.offPeakRatio = number(d.pricing.offPeakRatio);
        if (d.pricing.models.default !== '') pricing.models.default = d.pricing.models.default;
        if (d.pricing.models.overrides !== '') pricing.models.overrides = d.pricing.models.overrides;
        const official = { mode: d.official.mode };
        if (number(d.official.pollSeconds) != null) official.pollSeconds = number(d.official.pollSeconds);
        const external = { enabled: d.external.enabled === true };
        if (number(d.external.port) != null) external.port = number(d.external.port);
        const sampling = {};
        if (number(d.sampling.netGpuSeconds) != null) sampling.netGpuSeconds = number(d.sampling.netGpuSeconds);
        if (number(d.sampling.diskSeconds) != null) sampling.diskSeconds = number(d.sampling.diskSeconds);
        if (number(d.sampling.dshsizeMinutes) != null) sampling.dshsizeMinutes = number(d.sampling.dshsizeMinutes);
        return {
          pricing,
          official,
          whale: { enabled: d.whale.enabled === true, path: d.whale.path },
          external,
          sampling,
        };
      };

      const save = async (payload, kind) => {
        setBusy(true);
        setNotice(null);
        try {
          const value = await hostFetch('/api/dsh-resmon/config', payload, undefined, 'POST');
          setDraft(normalizeConfig(value));
          setNotice({ tone: 'ok', text: kind === 'reset' ? t('sResetDone') : t('sSaved') });
        } catch (error) {
          setNotice({ tone: 'err', text: `${t('sSaveFailed')}: ${error instanceof Error ? error.message : String(error)}` });
        } finally {
          setBusy(false);
        }
      };

      const onReset = () => void save({
        pricing: { offPeakRatio: 0.5, models: { overrides: '{}' } },
        official: { mode: 'auto', pollSeconds: 60 },
        whale: { enabled: true, path: '' },
        external: { enabled: false, port: 57123 },
        sampling: { netGpuSeconds: 2, diskSeconds: 5, dshsizeMinutes: 5 },
      }, 'reset');

      const onGenSpec = async () => {
        setBusy(true);
        setSpecNotice(null);
        try {
          const value = await hostFetch('/api/dsh-resmon/spec', undefined, undefined, 'POST');
          const path = value && value.path ? value.path : '';
          setSpecNotice({ tone: 'ok', text: `${t('sGenSpecDone')}: ${path}` });
        } catch (error) {
          setSpecNotice({ tone: 'err', text: `${t('sGenSpecFailed')}: ${error instanceof Error ? error.message : String(error)}` });
        } finally {
          setBusy(false);
        }
      };

      const field = (labelKey, control) => h('label', { className: 'drs-field' },
        h('span', { className: 'drs-field-label' }, t(labelKey)),
        control);
      const fieldBlock = (labelKey, control) => h('div', { className: 'drs-field-block' },
        h('span', { className: 'drs-field-label' }, t(labelKey)),
        control);

      return h('div', { className: 'drs-wrap' },
        h('style', null, SETTINGS_CSS),
        h('div', { className: 'drs-title' }, t('settingsTitle')),
        h('div', { className: 'drs-desc' }, t('settingsDesc')),
        h('div', { className: 'drs-group' },
          h('div', { className: 'drs-group-title' }, t('sPricing')),
          field('sOffPeakRatio', h('input', {
            type: 'number', className: 'drs-input', min: 0, max: 1, step: 0.05,
            value: d.pricing.offPeakRatio,
            onChange: (event) => patchPricing('offPeakRatio', event.target.value),
          })),
          fieldBlock('sDefaultPrice', h('textarea', {
            className: 'drs-textarea', rows: 3,
            value: d.pricing.models.default,
            placeholder: '{"input":2,"cachedInput":0.5,"output":8}',
            onChange: (event) => patchModels('default', event.target.value),
          })),
          fieldBlock('sOverrides', h('textarea', {
            className: 'drs-textarea', rows: 3,
            value: d.pricing.models.overrides,
            placeholder: '{"deepseek-flash":{"input":2,"cachedInput":0.04,"output":8}}',
            onChange: (event) => patchModels('overrides', event.target.value),
          }))),
        h('div', { className: 'drs-group' },
          h('div', { className: 'drs-group-title' }, t('sOfficial')),
          field('sMode', h('select', {
            className: 'drs-input',
            value: d.official.mode,
            onChange: (event) => patchOfficial('mode', event.target.value),
          },
            h('option', { value: 'auto' }, t('sModeAuto')),
            h('option', { value: 'apikey' }, t('sModeApikey')),
            h('option', { value: 'account' }, t('sModeAccount')),
            h('option', { value: 'off' }, t('sModeOff')))),
          field('sPollSeconds', h('input', {
            type: 'number', className: 'drs-input', min: 15, max: 600,
            value: d.official.pollSeconds,
            onChange: (event) => patchOfficial('pollSeconds', event.target.value),
          }))),
        h('div', { className: 'drs-group' },
          h('div', { className: 'drs-group-title' }, t('sWhale')),
          field('sWhaleEnabled', h('input', {
            type: 'checkbox',
            checked: d.whale.enabled,
            onChange: (event) => patchWhale('enabled', event.target.checked),
          })),
          field('sWhalePath', h('input', {
            type: 'text', className: 'drs-input drs-input-wide',
            value: d.whale.path,
            placeholder: t('sWhalePathHint'),
            onChange: (event) => patchWhale('path', event.target.value),
          }))),
        h('div', { className: 'drs-group' },
          h('div', { className: 'drs-group-title' }, t('sExternal')),
          field('sExternalEnabled', h('input', {
            type: 'checkbox',
            checked: d.external.enabled,
            onChange: (event) => patchExternal('enabled', event.target.checked),
          })),
          field('sExternalPort', h('input', {
            type: 'number', className: 'drs-input', min: 1024, max: 65535,
            value: d.external.port,
            onChange: (event) => patchExternal('port', event.target.value),
          })),
          h('div', { className: 'drs-hint' }, t('sExternalHint')),
          h('div', { className: 'drs-spec-row' },
            h('button', { type: 'button', className: 'drs-btn', disabled: busy, onClick: onGenSpec }, t('sGenSpec')),
            specNotice ? h('span', { className: specNotice.tone === 'ok' ? 'drs-notice drs-notice-ok' : 'drs-notice drs-notice-err' }, specNotice.text) : null)),
        h('div', { className: 'drs-group' },
          h('div', { className: 'drs-group-title' }, t('sSampling')),
          field('sNetGpu', h('input', {
            type: 'number', className: 'drs-input', min: 1, max: 30,
            value: d.sampling.netGpuSeconds,
            onChange: (event) => patchSampling('netGpuSeconds', event.target.value),
          })),
          field('sDisk', h('input', {
            type: 'number', className: 'drs-input', min: 2, max: 120,
            value: d.sampling.diskSeconds,
            onChange: (event) => patchSampling('diskSeconds', event.target.value),
          })),
          field('sDshSize', h('input', {
            type: 'number', className: 'drs-input', min: 1, max: 120,
            value: d.sampling.dshsizeMinutes,
            onChange: (event) => patchSampling('dshsizeMinutes', event.target.value),
          }))),
        h('div', { className: 'drs-actions' },
          h('button', { type: 'button', className: 'drs-btn drs-btn-primary', disabled: busy, onClick: () => void save(buildPayload(), 'save') }, t('sSave')),
          h('button', { type: 'button', className: 'drs-btn', disabled: busy, onClick: onReset }, t('sReset')),
          notice ? h('span', { className: notice.tone === 'ok' ? 'drs-notice drs-notice-ok' : 'drs-notice drs-notice-err' }, notice.text) : null));
    }

    const SETTINGS_CSS = `
      .drs-wrap {
        max-width: 640px;
        padding: 8px 2px 16px;
        font-size: 13px;
        line-height: 1.5;
        color: var(--dsw-alias-label-primary);
      }
      .drs-title {
        font-size: 15px;
        font-weight: 600;
        margin-bottom: 4px;
      }
      .drs-desc {
        color: var(--dsw-alias-label-secondary);
        font-size: 12px;
        margin-bottom: 12px;
      }
      .drs-loading {
        color: var(--dsw-alias-label-secondary);
      }
      .drs-error {
        color: var(--dsw-alias-state-error-primary);
        font-size: 12.5px;
      }
      .drs-group {
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 10px;
        background: var(--dsw-alias-bg-layer-1);
        padding: 10px 12px;
        margin-bottom: 10px;
      }
      .drs-group-title {
        font-weight: 600;
        font-size: 12.5px;
        margin-bottom: 6px;
      }
      .drs-field {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-top: 6px;
      }
      .drs-field-label {
        color: var(--dsw-alias-label-secondary);
        font-size: 12px;
        flex: 0 0 150px;
      }
      .drs-field-block {
        margin-top: 8px;
      }
      .drs-field-block .drs-field-label {
        display: block;
        margin-bottom: 4px;
      }
      .drs-input {
        width: 120px;
        box-sizing: border-box;
        border: 1px solid var(--dsw-alias-border-l2);
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-primary);
        border-radius: 6px;
        padding: 4px 8px;
        font-size: 12px;
        font-family: inherit;
      }
      .drs-input-wide {
        width: 280px;
      }
      .drs-hint {
        color: var(--dsw-alias-label-secondary);
        font-size: 11px;
        margin-top: 6px;
      }
      .drs-spec-row {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-top: 8px;
      }
      .drs-textarea {
        box-sizing: border-box;
        width: 100%;
        border: 1px solid var(--dsw-alias-border-l2);
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-primary);
        border-radius: 6px;
        padding: 6px 8px;
        font-size: 12px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        resize: vertical;
      }
      .drs-actions {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-top: 4px;
      }
      .drs-btn {
        border: 1px solid var(--dsw-alias-border-l2);
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-primary);
        border-radius: 6px;
        padding: 5px 14px;
        font-size: 12px;
        cursor: pointer;
        font-family: inherit;
      }
      .drs-btn:hover {
        border-color: var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-1);
      }
      .drs-btn:disabled {
        opacity: 0.55;
        cursor: default;
      }
      .drs-btn-primary {
        background: var(--dsw-alias-brand-primary);
        border-color: transparent;
        color: #ffffff;
      }
      .drs-btn-primary:hover {
        background: var(--dsw-alias-brand-primary);
        border-color: transparent;
        color: #ffffff;
      }
      .drs-notice {
        font-size: 12px;
      }
      .drs-notice-ok {
        color: var(--dsw-alias-state-success-primary);
      }
      .drs-notice-err {
        color: var(--dsw-alias-state-error-primary);
      }
    `;

    const PANEL_CSS = `
      .drm-root {
        position: fixed;
        left: 12px;
        bottom: 12px;
        pointer-events: none;
        display: flex;
        flex-direction: column-reverse;
        align-items: flex-start;
      }
      .drm-card {
        pointer-events: auto;
        width: 250px;
        box-sizing: border-box;
        background: var(--dsw-alias-bg-overlay);
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 10px;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.16);
        padding: 10px 12px 8px;
        color: var(--dsw-alias-label-primary);
        font-size: 12px;
        line-height: 1.4;
        user-select: none;
      }
      .drm-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 2px;
      }
      .drm-drag {
        cursor: move;
        touch-action: none;
      }
      .drm-title {
        font-weight: 600;
        font-size: 12px;
        pointer-events: none;
      }
      .drm-close {
        background: none;
        border: none;
        padding: 0 4px;
        margin: 0;
        cursor: pointer;
        color: var(--dsw-alias-label-secondary);
        font-size: 12px;
        line-height: 1;
        border-radius: 4px;
      }
      .drm-close:hover {
        color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-bg-layer-2);
      }
      .drm-row {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        margin-top: 6px;
      }
      .drm-sub {
        margin-top: 2px;
        font-size: 10px;
        color: var(--dsw-alias-label-secondary);
      }
      .drm-sub .drm-value {
        font-weight: 400;
      }
      .drm-label {
        color: var(--dsw-alias-label-secondary);
        font-size: 11px;
      }
      .drm-value {
        font-variant-numeric: tabular-nums;
        font-weight: 600;
      }
      .drm-chips {
        display: flex;
        gap: 4px;
        margin-top: 6px;
      }
      .drm-scope {
        margin-top: 6px;
        margin-bottom: 2px;
      }
      .drm-chip {
        flex: 1;
        border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-secondary);
        border-radius: 6px;
        padding: 3px 0;
        font-size: 11px;
        cursor: pointer;
        font-family: inherit;
      }
      .drm-chip:hover {
        color: var(--dsw-alias-label-primary);
        border-color: var(--dsw-alias-border-l2);
      }
      .drm-chip-active {
        background: var(--dsw-alias-brand-primary);
        border-color: transparent;
        color: #ffffff;
      }
      .drm-chip-active:hover {
        color: #ffffff;
        border-color: transparent;
      }
      .drm-lines {
        margin-top: 4px;
      }
      .drm-line {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        font-size: 11px;
        margin-top: 3px;
      }
      .drm-pricing {
        font-weight: 400;
        color: var(--dsw-alias-label-secondary);
        text-align: right;
        overflow-wrap: anywhere;
      }
      .drm-src {
        margin-left: 4px;
        font-size: 10px;
        font-weight: 400;
        color: var(--dsw-alias-label-secondary);
        font-variant-numeric: tabular-nums;
      }
      .drm-warn {
        margin-top: 3px;
        font-size: 10px;
        color: var(--dsw-alias-state-warn-primary);
      }
      .drm-official-note {
        margin-top: 6px;
        font-size: 10px;
        color: var(--dsw-alias-label-secondary);
      }
      .drm-official-note a {
        color: var(--dsw-alias-brand-primary);
        text-decoration: underline;
      }
      .drm-official-note a:hover {
        color: var(--dsw-alias-label-primary);
      }
      .drm-foot {
        margin-top: 8px;
        border-top: 1px solid var(--dsw-alias-border-l1);
        padding-top: 6px;
        color: var(--dsw-alias-label-secondary);
        font-size: 10px;
        display: flex;
        justify-content: space-between;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .drm-section {
        border-top: 1px solid var(--dsw-alias-border-l1);
        padding-top: 6px;
        margin-top: 8px;
      }
      .drm-section-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        margin-bottom: 2px;
      }
      .drm-section-title {
        font-weight: 600;
        font-size: 11px;
        color: var(--dsw-alias-label-secondary);
      }
      .drm-remove {
        background: none;
        border: none;
        padding: 0 4px;
        margin: 0;
        cursor: pointer;
        color: var(--dsw-alias-label-secondary);
        font-size: 13px;
        line-height: 1;
        border-radius: 4px;
      }
      .drm-remove:hover {
        color: var(--dsw-alias-state-error-primary);
        background: var(--dsw-alias-bg-layer-2);
      }
      .drm-empty {
        padding: 8px 0 2px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .drm-empty-hint {
        color: var(--dsw-alias-label-secondary);
        font-size: 10px;
        text-align: center;
      }
      .drm-add {
        display: flex;
        flex-direction: column;
        gap: 4px;
        margin-top: 8px;
      }
      .drm-add-btn {
        border: 1px dashed var(--dsw-alias-border-l2);
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-brand-primary);
        border-radius: 6px;
        padding: 4px 0;
        font-size: 11px;
        cursor: pointer;
        font-family: inherit;
      }
      .drm-add-btn:hover {
        background: var(--dsw-alias-bg-layer-1);
      }
      .drm-menu {
        display: flex;
        flex-direction: column;
        gap: 2px;
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 6px;
        background: var(--dsw-alias-bg-layer-2);
        padding: 4px;
      }
      .drm-menu-item {
        background: none;
        border: none;
        color: var(--dsw-alias-label-primary);
        text-align: left;
        padding: 3px 8px;
        border-radius: 4px;
        font-size: 11px;
        cursor: pointer;
        font-family: inherit;
      }
      .drm-menu-item:hover {
        background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-brand-primary);
      }
      .drm-pill {
        pointer-events: auto;
        display: flex;
        gap: 5px;
        align-items: center;
        background: var(--dsw-alias-bg-overlay);
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 999px;
        padding: 4px 12px;
        font-size: 11px;
        color: var(--dsw-alias-label-primary);
        cursor: grab;
        box-shadow: 0 3px 10px rgba(0, 0, 0, 0.14);
        touch-action: none;
      }
      .drm-pill:active {
        cursor: grabbing;
      }
      .drm-pill b {
        font-variant-numeric: tabular-nums;
      }
      .drm-pill-badge {
        color: var(--dsw-alias-brand-primary);
        font-weight: 700;
      }
    `;

    /* ------------------------------------------------------------------ *
     * Plugin entry                                                        *
     * ------------------------------------------------------------------ */
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind('dsh-resmon');
        const dicts = {
          en: {
            title: 'Resource Monitor',
            cpu: 'CPU',
            memory: 'Memory',
            memoryShort: 'RAM',
            tokens: 'Tokens',
            thisTurn: 'This turn',
            thisTurnTitle: 'Token usage of the current question round',
            thisSession: 'Session',
            thisSessionTitle: 'Token usage of this session',
            today: 'Today',
            todayTitle: "Token usage since today's midnight",
            total: 'Cumulative',
            totalTitle: 'Cumulative token usage recorded by this plugin',
            input: 'Input',
            output: 'Output',
            sum: 'Total',
            uptime: 'up',
            collapse: 'Collapse',
            expand: 'Expand',
            noSession: 'no session',
            scopeMachine: 'Machine',
            scopeMachineTitle: 'Whole-machine CPU and memory usage',
            scopeDsh: 'DSH',
            scopeDshTitle: 'DeepSeek Harness backend process usage (this process)',
            addItem: 'Add monitor item',
            removeItem: 'Remove',
            itemCpu: 'CPU',
            itemMem: 'Memory',
            itemDisk: 'Disk',
            itemNet: 'Network',
            itemGpu: 'GPU',
            itemTokens: 'Tokens',
            itemCost: 'Cost',
            netDown: 'Down',
            netUp: 'Up',
            gpuVram: 'VRAM',
            unavailable: 'Unavailable',
            costPricing: 'Pricing',
            costEstimated: 'Estimated (running)',
            costPerM: 'per 1M',
            costIn: 'in',
            costOut: 'out',
            periodPeak: 'Peak',
            periodOffpeak: 'Off-peak',
            reasoningHigh: 'high',
            reasoningMedium: 'medium',
            reasoningLow: 'low',
            emptyPanel: 'Click “Add monitor item” to choose metrics',
            diskUsed: 'used',
            emptyPill: 'click to expand',
            itemDshSize: 'DSH Footprint',
            dshApp: 'App',
            dshHome: 'Data',
            dshTotal: 'Total',
            diskActive: 'Active time',
            computing: 'Calculating…',
            costPredicted: 'Real-time prediction',
            sourceOfficial: 'Official',
            sourceLocal: 'Local estimate',
            sourceApiKey: 'API Key',
            sourceAccount: 'Account',
            balanceStale: 'Stale',
            needsReview: 'Balance rose (likely top-up); review today usage',
            officialNote: 'Official data prevails · Open official usage',
            officialBalance: 'Official balance',
            bonus: 'Bonus',
            recharge: 'Recharge',
            sourceOfficialPlatform: 'Official platform',
            officialMonth: 'Official this month',
            settingsNav: 'Resource Monitor',
            settingsTitle: 'Resource Monitor Settings',
            settingsDesc: 'Configure pricing, the official data source, the whale ledger and the sampling cadence. Changes apply immediately.',
            sPricing: 'Pricing',
            sOffPeakRatio: 'Off-peak price ratio',
            sDefaultPrice: 'Default pricing (JSON)',
            sOverrides: 'Model price overrides (JSON)',
            sOfficial: 'Official data source',
            sMode: 'Mode',
            sModeAuto: 'Auto',
            sModeApikey: 'API key',
            sModeAccount: 'Account',
            sModeOff: 'Off',
            sPollSeconds: 'Balance poll interval (s)',
            sWhale: 'Whale ledger',
            sWhaleEnabled: 'Enabled',
            sWhalePath: 'Ledger path',
            sWhalePathHint: 'empty = default ~/.dsh/.dshw-usage.json',
            sSampling: 'Sampling',
            sNetGpu: 'Net/GPU interval (s)',
            sDisk: 'Disk interval (s)',
            sDshSize: 'DSH size recompute (min)',
            sSave: 'Save & apply',
            sSaved: 'Saved and applied',
            sReset: 'Reset to defaults',
            sResetDone: 'Defaults restored and applied',
            sLoadFailed: 'Failed to load config',
            sSaveFailed: 'Save failed',
            sLoading: 'Loading…',
            sExternal: 'External API',
            sExternalEnabled: 'Enabled',
            sExternalPort: 'Port',
            sExternalHint: 'Loopback only for local programs',
            sGenSpec: 'Generate API spec',
            sGenSpecDone: 'API spec generated',
            sGenSpecFailed: 'Generation failed',
          },
          zh: {
            title: '资源监控',
            cpu: 'CPU',
            memory: '内存',
            memoryShort: '内存',
            tokens: 'Token 消耗',
            thisTurn: '本轮',
            thisTurnTitle: '本次问答的 Token 消耗',
            thisSession: '会话',
            thisSessionTitle: '本次会话的 Token 消耗',
            today: '今日',
            todayTitle: '从今天 0 点起的 Token 消耗',
            total: '累计',
            totalTitle: '本插件记录的累计 Token 消耗',
            input: '输入',
            output: '输出',
            sum: '合计',
            uptime: '已运行',
            collapse: '收起',
            expand: '展开',
            noSession: '未打开会话',
            scopeMachine: '整机',
            scopeMachineTitle: '整机 CPU 与内存占用',
            scopeDsh: 'DSH',
            scopeDshTitle: 'DeepSeek Harness 后端进程占用(本进程)',
            addItem: '添加监控项目',
            removeItem: '移除',
            itemCpu: 'CPU',
            itemMem: '内存',
            itemDisk: '磁盘',
            itemNet: '网络',
            itemGpu: 'GPU',
            itemTokens: 'Token 消耗',
            itemCost: '费用',
            netDown: '下行',
            netUp: '上行',
            gpuVram: '显存',
            unavailable: '不可用',
            costPricing: '计价',
            costEstimated: '预计(进行中)',
            costPerM: '/百万',
            costIn: '输入',
            costOut: '输出',
            periodPeak: '高峰',
            periodOffpeak: '空闲',
            reasoningHigh: '高推理',
            reasoningMedium: '中推理',
            reasoningLow: '低推理',
            emptyPanel: '点击「添加监控项目」选择要显示的指标',
            diskUsed: '已用',
            emptyPill: '点击展开',
            itemDshSize: 'DSH 占用',
            dshApp: '应用',
            dshHome: '数据',
            dshTotal: '合计',
            diskActive: '活动时间',
            computing: '计算中…',
            costPredicted: '实时预测',
            sourceOfficial: '官方余额差',
            sourceLocal: '本地估算',
            sourceApiKey: 'API Key',
            sourceAccount: '账户登录',
            balanceStale: '数据可能过期',
            needsReview: '余额上升(可能充值),今日已用待校正',
            officialNote: '以官方平台为准 · 查看官方用量',
            officialBalance: '官方余额',
            bonus: '赠金',
            recharge: '充值',
            sourceOfficialPlatform: '官方平台',
            officialMonth: '官方本月',
            settingsNav: '资源监控',
            settingsTitle: '资源监控设置',
            settingsDesc: '配置计价、官方数据源、小鲸鱼账本与采样节奏;保存后立即生效,无需重启。',
            sPricing: '计价配置',
            sOffPeakRatio: '空闲时段价格系数',
            sDefaultPrice: '兜底计价(JSON)',
            sOverrides: '模型计价覆盖(JSON)',
            sOfficial: '官方数据源',
            sMode: '模式',
            sModeAuto: '自动',
            sModeApikey: 'API Key',
            sModeAccount: '账户登录',
            sModeOff: '关闭',
            sPollSeconds: '余额轮询间隔(秒)',
            sWhale: '小鲸鱼账本',
            sWhaleEnabled: '启用',
            sWhalePath: '账本路径',
            sWhalePathHint: '空=默认 ~/.dsh/.dshw-usage.json',
            sSampling: '采样节奏',
            sNetGpu: '网络/GPU 间隔(秒)',
            sDisk: '磁盘间隔(秒)',
            sDshSize: 'DSH 占用重算(分钟)',
            sSave: '保存并生效',
            sSaved: '已保存并生效',
            sReset: '恢复默认',
            sResetDone: '已恢复默认并生效',
            sLoadFailed: '加载配置失败',
            sSaveFailed: '保存失败',
            sLoading: '加载中…',
            sExternal: '外部程序接口',
            sExternalEnabled: '启用',
            sExternalPort: '监听端口',
            sExternalHint: '仅监听 127.0.0.1,供本机程序调用',
            sGenSpec: '生成接口规范文件',
            sGenSpecDone: '规范文件已生成',
            sGenSpecFailed: '生成失败',
          },
        };
        ctx.locale.register('dsh-resmon', 'en', dicts.en);
        ctx.locale.register('dsh-resmon', 'zh', dicts.zh);
        ctx.locale.register('dsh-resmon', 'zh-CN', dicts.zh);
        ctx.locale.register('dsh-resmon', 'zh-Hans', dicts.zh);
        const unsubscribeLocale = ctx.locale.subscribe(() => localeTick.set(localeTick.get() + 1));
        ctx.effect(() => unsubscribeLocale);

        // Learns the viewed session id (session-scoped seat).
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
          { name: 'conversation.composer.dock', id: 'dsh-resmon-tracker', order: 2 },
          SessionTracker,
        ));

        // The visible draggable bottom-left panel.
        ctx.slots.inject('shell.overlay', () => ctx.slots.register(
          { name: 'shell.overlay', id: 'dsh-resmon-panel', order: 0, label: () => t('title') },
          () => h(Panel, { t, getLocale: () => ctx.locale.getLocale().active }),
        ));

        // Standalone settings page, same level as the desktop-control entry.
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-resmon',
          order: 430,
          locale: 'dsh-resmon',
          label: () => {
            try {
              return ctx.locale.bind('dsh-resmon')('settingsNav');
            } catch {
              return '资源监控';
            }
          },
        }, (props) => h(SettingsPage, { ...props, t })));
      },
    };
  },
});
