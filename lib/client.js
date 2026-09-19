/**
 * LongLoop Console — browser half.
 *
 * One panel over `<cwd>/.longloop/`: the task board (priority, insert, reorder,
 * delete), the long-term memory files, the workspace skills, and the live
 * multi-agent roster. Reads and writes through the Host's authenticated
 * `/longloop` prefix, so it holds no state of its own beyond the open flag.
 */

window.__ModuleLoader__.load({
  id: '@alex-spacemit/dsh-longloop-console',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    /* ────────────────────────── shared open state ───────────────────────── */

    const listeners = new Set()
    let open = false
    const store = {
      subscribe(fn) {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
      isOpen: () => open,
      set(next) {
        open = next
        for (const fn of listeners) fn()
      },
    }

    function useOpen() {
      const [, force] = useState(0)
      useEffect(() => store.subscribe(() => force((n) => n + 1)), [])
      return open
    }

    /**
     * The label this plugin registers into `sidebar.panellist`.
     *
     * It doubles as the identity the row interceptor matches on, so the two
     * cannot drift apart: if the label changes, the whole row keeps working.
     */
    const PANEL_LABEL = '任务台'

    /* ───────────────────────────── data layer ──────────────────────────── */

    /** One line of the acceptance field → one contract criterion.
     *
     * Format: `陈述 | 命令 | 期望`, where 期望 is one of
     *   `退出码 0`            → expect.exitCode
     *   `stdout /正则/`       → expect.stdout
     *   `文件 path`           → expect.fileExists
     * A line with no command is a statement only: accepted, but reported as not
     * machine-checkable, because a run whose criteria cannot be decided is the
     * failure this framework exists to prevent.
     */
    function parseAcceptanceLines(text) {
      const out = []
      for (const raw of String(text ?? '').split('\n')) {
        const line = raw.trim()
        if (line.length === 0 || line.startsWith('（')) continue
        const parts = line.split('|').map((part) => part.trim())
        const statement = parts[0] ?? ''
        const command = parts[1] ?? ''
        const criterion = { statement: statement.length > 0 ? statement : command, weight: 'required' }
        if (command.length > 0) {
          criterion.check = { command }
          const expect = parseExpectation(parts[2])
          if (expect !== undefined) criterion.check.expect = expect
        }
        if (criterion.statement.length > 0) out.push(criterion)
      }
      return out
    }

    /** The expectation half of one acceptance line, or `undefined` for defaults. */
    function parseExpectation(text) {
      const value = String(text ?? '').trim()
      if (value.length === 0) return undefined
      const exit = /^(?:退出码|exit(?:\s*code)?)\s*(-?\d+)$/i.exec(value) ?? /^(-?\d+)$/.exec(value)
      if (exit !== null) return { exitCode: Number(exit[1]) }
      const stdout = /^(?:stdout\s*)?\/(.*)\/$/.exec(value)
      if (stdout !== null) return { stdoutMatches: stdout[1] }
      const file = /^(?:文件|file)\s+(.+)$/i.exec(value)
      if (file !== null) return { fileExists: file[1].trim() }
      // Free text is read as a stdout match: the least surprising reading, and
      // the one a shell user already expects from `| grep`.
      return { stdoutMatches: value }
    }

    async function api(path, init) {
      const response = await fetch(path, {
        credentials: 'same-origin',
        headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
        ...init,
      })
      const text = await response.text()
      let payload
      try {
        payload = text.length === 0 ? {} : JSON.parse(text)
      } catch {
        throw new Error(`bad response (${response.status})`)
      }
      if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
      return payload
    }

    const fetchState = (workspace) =>
      api(`/longloop/state${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''}`)

    const post = (route, body) => api(`/longloop/${route}`, { method: 'POST', body: JSON.stringify(body) })

    function useLongLoop() {
      const [state, setState] = useState(null)
      const [error, setError] = useState(null)
      const [workspace, setWorkspace] = useState(null)
      const [busy, setBusy] = useState(false)
      const [updatedAt, setUpdatedAt] = useState(null)
      const timer = useRef(null)

      const reload = useCallback(async () => {
        try {
          const next = await fetchState(workspace)
          if (next.ok === false) throw new Error(next.error ?? 'unknown workspace')
          setState(next)
          setError(null)
          setUpdatedAt(Date.now())
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        }
      }, [workspace])

      useEffect(() => {
        let alive = true
        const tick = async () => {
          if (!alive) return
          await reload()
          if (alive) timer.current = setTimeout(tick, 5000)
        }
        tick()
        return () => {
          alive = false
          if (timer.current !== null) clearTimeout(timer.current)
        }
      }, [reload])

      const mutate = useCallback(
        async (route, body) => {
          setBusy(true)
          try {
            const result = await post(route, { ...body, workspace: state?.workspace?.path })
            if (result.ok === false) setError(result.error ?? 'rejected')
            await reload()
            return result
          } catch (cause) {
            setError(String(cause?.message ?? cause))
            return { ok: false }
          } finally {
            setBusy(false)
          }
        },
        [reload, state?.workspace?.path],
      )

      return { state, error, setError, workspace, setWorkspace, busy, mutate, reload, updatedAt }
    }

    /**
     * §12's numbers, on the loop page.
     *
     * Loads with the same cadence as the rest of the console and renders the
     * report's own text: the host half already decides what is knowable, so the
     * console must not re-derive it. A failure says so rather than showing zeroes.
     */
    function MetricsCard({ workspace }) {
      const [report, setReport] = useState(null)
      const [error, setError] = useState(null)

      useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const next = await api(`/longloop/metrics${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''}`)
            if (!alive) return
            setReport(next)
            setError(null)
          } catch (cause) {
            if (alive) setError(String(cause?.message ?? cause))
          }
        }
        load()
        const timer = window.setInterval(load, 15000)
        return () => {
          alive = false
          window.clearInterval(timer)
        }
      }, [workspace])

      return h(
        'div',
        { style: { ...S.card, marginTop: '10px' } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
          h('div', { style: { ...S.dim, fontSize: '11px' } }, '度量（§12）'),
          h(
            'span',
            {
              style: { ...S.dim, marginLeft: 'auto', fontSize: '11px' },
              title: '这些数字只陈述台账能证明的东西；不能证明的写在「缺什么」里',
            },
            report?.report?.scope ? `${report.report.scope.runs} 条运行` : '—',
          ),
        ),
        error !== null
          ? h('div', { style: { fontSize: '11px', color: pick('--dsw-alias-state-error-primary') } }, `读不到度量：${error}`)
          : h(
              'pre',
              {
                style: {
                  margin: '6px 0 0',
                  whiteSpace: 'pre-wrap',
                  fontFamily: 'ui-monospace, monospace',
                  fontSize: '11px',
                  lineHeight: '1.5',
                  color: 'inherit',
                },
              },
              report?.text ?? '还没有可统计的台账。',
            ),
      )
    }

    /* ─────────────────────────────── styling ───────────────────────────── */

    const S = {
      panel: {
        position: 'fixed',
        // Below the shell's top bars: the session header carries our own 任务台
        // toggle, and a full-height overlay would cover the control that closes it.
        top: '42px',
        right: 0,
        height: 'calc(100vh - 42px)',
        width: '460px',
        maxWidth: '96vw',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--dsw-alias-bg-overlay, #fff)',
        color: 'var(--dsw-alias-label-primary, #111)',
        borderLeft: '1px solid var(--dsw-alias-border-l1, #ddd)',
        boxShadow: '0 0 0 1px rgba(0,0,0,.04), -12px 0 32px rgba(0,0,0,.10)',
        font: '13px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
        zIndex: 60,
      },
      head: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '10px 12px',
        borderBottom: '1px solid var(--dsw-alias-border-l1, #ddd)',
        background: 'var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-layer-1, #f7f7f7))',
      },
      tabs: {
        display: 'flex',
        gap: '2px',
        padding: '6px 8px',
        borderBottom: '1px solid var(--dsw-alias-border-l1, #ddd)',
      },
      body: { flex: 1, overflowY: 'auto', padding: '10px 12px' },
      dim: { color: 'var(--dsw-alias-label-secondary, #666)' },
      btn: {
        font: 'inherit',
        padding: '3px 8px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2, #ccc)',
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
        color: 'inherit',
        cursor: 'pointer',
      },
      chip: {
        font: '11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
        padding: '1px 6px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l2, #ccc)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      input: {
        font: 'inherit',
        padding: '5px 8px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2, #ccc)',
        background: 'var(--dsw-alias-bg-base, #fff)',
        color: 'inherit',
        width: '100%',
        boxSizing: 'border-box',
      },
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '6px 8px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1, #e5e5e5)',
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
        marginBottom: '6px',
      },
      card: {
        padding: '8px 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1, #e5e5e5)',
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
        marginBottom: '8px',
      },
      err: {
        padding: '6px 10px',
        borderRadius: '6px',
        marginBottom: '8px',
        border: '1px solid var(--dsw-alias-state-error-primary, #c00)',
        color: 'var(--dsw-alias-state-error-primary, #c00)',
      },
      badge: {
        minWidth: '16px',
        marginLeft: '4px',
        padding: '0 4px',
        borderRadius: '999px',
        font: '10px/16px ui-monospace, SFMono-Regular, Menlo, monospace',
        textAlign: 'center',
        background: 'var(--dsw-alias-border-l1, #e5e5e5)',
        color: 'inherit',
      },
      dot: { width: '6px', height: '6px', borderRadius: '50%', display: 'inline-block', marginLeft: '5px' },
    }

    const PRIORITY_LABEL = ['P0', 'P1', 'P2', 'P3']
    const PRIORITY_COLOR = ['--dsw-alias-state-error-primary', '--dsw-alias-state-warn-primary', '--dsw-alias-label-secondary', '--dsw-alias-label-secondary']
    const STATUS_LABEL = { pending: '待办', in_progress: '进行中', blocked: '阻塞', done: '完成', dropped: '废弃' }
    const STATUS_ORDER = ['pending', 'in_progress', 'blocked', 'done', 'dropped']

    const pick = (name) => `var(${name}, currentColor)`

    /** `5520000` is not a duration anyone reads; sub-minute budgets stay in seconds. */
    function formatDuration(ms) {
      const total = Math.max(0, Math.round(Number(ms) / 1000))
      if (total < 90) return `${total} 秒`
      const minutes = Math.round(total / 60)
      return minutes < 90 ? `${minutes} 分` : `${(minutes / 60).toFixed(1)} 小时`
    }

    /**
     * One line describing what a frozen check expects — the same precedence the
     * verifier applies (exitCode, then stdoutMatches, then fileExists, else 0).
     */
    function describeExpect(expect) {
      if (expect?.stdoutMatches !== undefined) return `输出匹配 /${expect.stdoutMatches}/`
      if (expect?.fileExists !== undefined) return `文件存在 ${expect.fileExists}`
      return `退出码 ${expect?.exitCode ?? 0}`
    }

    /* ──────────────────────────────── tasks ────────────────────────────── */

    function TaskBoard({ ll }) {
      const [draft, setDraft] = useState('')
      const [draftPriority, setDraftPriority] = useState(2)
      const [editing, setEditing] = useState(null)
      const [filter, setFilter] = useState('open')
      const [confirming, setConfirming] = useState(null)
      const tasks = ll.state?.tasks ?? []

      const countOf = (status) => tasks.filter((task) => task.status === status).length
      const openCount = countOf('pending') + countOf('in_progress') + countOf('blocked')
      const visible = tasks.filter((task) =>
        filter === 'all'
          ? true
          : filter === 'open'
            ? task.status === 'pending' || task.status === 'in_progress' || task.status === 'blocked'
            : task.status === filter,
      )
      const finished = tasks.filter((task) => task.status === 'done' || task.status === 'dropped')

      // A delete that needs a second click is a delete nobody does by accident;
      // the confirmation expires on its own so a stale red button never lingers.
      useEffect(() => {
        if (confirming === null) return undefined
        const timer = window.setTimeout(() => setConfirming(null), 4000)
        return () => window.clearTimeout(timer)
      }, [confirming])

      const add = async () => {
        const title = draft.trim()
        if (title.length === 0) return
        await ll.mutate('task', { op: 'create', title, priority: draftPriority })
        setDraft('')
      }

      return h(
        'div',
        null,
        h(
          'div',
          { style: { display: 'flex', gap: '6px', marginBottom: '10px' } },
          h('input', {
            style: S.input,
            placeholder: '新增任务，回车提交',
            value: draft,
            onChange: (e) => setDraft(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter') add()
            },
          }),
          h(
            'select',
            {
              style: { ...S.input, width: '74px' },
              value: draftPriority,
              onChange: (e) => setDraftPriority(Number(e.target.value)),
            },
            PRIORITY_LABEL.map((label, value) => h('option', { key: label, value }, label)),
          ),
          h('button', { style: S.btn, onClick: add, disabled: ll.busy }, '添加'),
        ),

        h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '8px' } },
          [
            ['open', '未完成', openCount],
            ['all', '全部', tasks.length],
            ['pending', '待办', countOf('pending')],
            ['in_progress', '进行中', countOf('in_progress')],
            ['blocked', '阻塞', countOf('blocked')],
            ['done', '完成', countOf('done')],
          ].map(([key, label, count]) =>
            h(
              'button',
              {
                key,
                style: {
                  ...S.chip,
                  borderColor: filter === key ? pick('--dsw-alias-brand-primary') : undefined,
                  color: filter === key ? pick('--dsw-alias-brand-primary') : 'inherit',
                },
                onClick: () => setFilter(key),
              },
              `${label} ${count}`,
            ),
          ),
        ),

        tasks.length === 0
          ? h('div', { style: S.dim }, '还没有任务。上面加一条，或让智能体写 .longloop/tasks.json。')
          : null,
        tasks.length > 0 && visible.length === 0
          ? h('div', { style: S.dim }, `「${filter === 'open' ? '未完成' : filter}」里没有任务。`)
          : null,

        visible.map((task, index) =>
          h(
            'div',
            { key: task.id, style: { ...S.row, opacity: task.status === 'done' || task.status === 'dropped' ? 0.55 : 1 } },
            h(
              'button',
              {
                style: {
                  ...S.chip,
                  color: pick(PRIORITY_COLOR[task.priority] ?? PRIORITY_COLOR[2]),
                  borderColor: 'currentColor',
                },
                title: '点击切换优先级',
                onClick: () => ll.mutate('task', { op: 'update', id: task.id, patch: { priority: (task.priority + 1) % 4 } }),
              },
              PRIORITY_LABEL[task.priority] ?? 'P2',
            ),
            h(
              'div',
              { style: { flex: 1, minWidth: 0 } },
              editing === task.id
                ? h('input', {
                    style: S.input,
                    autoFocus: true,
                    defaultValue: task.title,
                    onBlur: (e) => {
                      setEditing(null)
                      if (e.target.value.trim() !== task.title) {
                        ll.mutate('task', { op: 'update', id: task.id, patch: { title: e.target.value } })
                      }
                    },
                    onKeyDown: (e) => {
                      if (e.key === 'Enter') e.target.blur()
                      if (e.key === 'Escape') setEditing(null)
                    },
                  })
                : h(
                    'div',
                    {
                      style: {
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        textDecoration: task.status === 'done' ? 'line-through' : 'none',
                        cursor: 'text',
                      },
                      title: `${task.id} · ${task.note || task.title}`,
                      onDoubleClick: () => setEditing(task.id),
                    },
                    h('span', { style: { ...S.dim, marginRight: '6px' } }, task.id),
                    task.title,
                    task.owner ? h('span', { style: { ...S.dim, marginLeft: '6px' } }, `@${task.owner}`) : null,
                  ),
            ),
            h(
              'button',
              {
                style: S.chip,
                title: '点击切换状态',
                onClick: () => {
                  const at = STATUS_ORDER.indexOf(task.status)
                  ll.mutate('task', { op: 'update', id: task.id, patch: { status: STATUS_ORDER[(at + 1) % STATUS_ORDER.length] } })
                },
              },
              STATUS_LABEL[task.status] ?? task.status,
            ),
            h('button', {
              style: S.chip,
              title: filter === 'all' ? '上移' : '排序只在「全部」视图里可改（当前是筛选视图）',
              disabled: ll.busy || filter !== 'all' || index === 0,
              onClick: () => ll.mutate('task', { op: 'move', id: task.id, delta: -1 }),
            }, '↑'),
            h('button', {
              style: S.chip,
              title: filter === 'all' ? '下移' : '排序只在「全部」视图里可改（当前是筛选视图）',
              disabled: ll.busy || filter !== 'all' || index === visible.length - 1,
              onClick: () => ll.mutate('task', { op: 'move', id: task.id, delta: 1 }),
            }, '↓'),
            confirming === task.id
              ? h(
                  'button',
                  {
                    style: { ...S.chip, borderColor: 'currentColor', color: pick('--dsw-alias-state-error-primary') },
                    title: '再点一次确认删除',
                    disabled: ll.busy,
                    onClick: () => {
                      setConfirming(null)
                      ll.mutate('task', { op: 'delete', id: task.id })
                    },
                  },
                  '确认删除',
                )
              : h(
                  'button',
                  {
                    style: S.chip,
                    title: '删除',
                    disabled: ll.busy,
                    onClick: () => setConfirming(task.id),
                  },
                  '×',
                ),
          ),
        ),

        finished.length > 0
          ? h(
              'div',
              { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '2px' } },
              h(
                'button',
                {
                  style: S.chip,
                  disabled: ll.busy,
                  title: '把「完成 / 废弃」的任务从板上清掉（文件里也不留）',
                  onClick: async () => {
                    for (const task of finished) await ll.mutate('task', { op: 'delete', id: task.id })
                  },
                },
                `清除已完成 ${finished.length}`,
              ),
            )
          : null,

        ll.state?.tasksMalformed
          ? h('div', { style: { ...S.dim, marginTop: '8px' } }, '⚠ tasks.json 无法解析，已按空板显示；原文件未被改动。')
          : null,
        h('div', { style: { ...S.dim, marginTop: '10px' } }, `文件：${ll.state?.paths?.tasks ?? ''}`),
      )
    }

    /* ─────────────────────────────── memory ────────────────────────────── */

    function Memory({ ll }) {
      const entries = ll.state?.memory ?? []
      const [active, setActive] = useState(null)
      const [draftText, setDraftText] = useState('')
      const [newName, setNewName] = useState('')
      const [confirmDelete, setConfirmDelete] = useState(false)

      // Deleting a memory file is destructive and the chip stays under the pointer
      // afterwards, so the second click is what actually deletes.
      useEffect(() => {
        if (!confirmDelete) return undefined
        const timer = window.setTimeout(() => setConfirmDelete(false), 4000)
        return () => window.clearTimeout(timer)
      }, [confirmDelete])

      useEffect(() => {
        setConfirmDelete(false)
      }, [active])

      const current = entries.find((e) => e.name === active)

      useEffect(() => {
        if (active === null && entries.length > 0) setActive(entries[0].name)
      }, [entries, active])

      const load = async (name) => {
        setActive(name)
        const full = await fetchState(ll.state?.workspace?.path)
        const hit = (full.memory ?? []).find((e) => e.name === name)
        setDraftText(hit?.content ?? hit?.preview ?? '')
      }

      useEffect(() => {
        if (current !== undefined) setDraftText(current.preview ?? '')
      }, [active])

      return h(
        'div',
        null,
        h(
          'div',
          { style: { display: 'flex', gap: '6px', marginBottom: '10px' } },
          h('input', {
            style: S.input,
            placeholder: '新记忆文件名（英文，如 redis-migration）',
            value: newName,
            onChange: (e) => setNewName(e.target.value),
          }),
          h(
            'button',
            {
              style: S.btn,
              disabled: ll.busy,
              onClick: async () => {
                const name = newName.trim()
                if (name.length === 0) return
                await ll.mutate('memory', { op: 'write', name, content: `# ${name}\n\n` })
                setNewName('')
                setActive(name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, ''))
              },
            },
            '新建',
          ),
        ),

        h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '10px' } },
          entries.map((entry) =>
            h(
              'button',
              {
                key: entry.name,
                style: {
                  ...S.chip,
                  borderColor: entry.name === active ? pick('--dsw-alias-brand-primary') : undefined,
                  color: entry.name === active ? pick('--dsw-alias-brand-primary') : 'inherit',
                },
                onClick: () => load(entry.name),
              },
              entry.name,
            ),
          ),
          entries.length === 0 ? h('span', { style: S.dim }, '还没有记忆文件。') : null,
        ),

        current !== undefined
          ? h(
              'div',
              null,
              h('textarea', {
                style: { ...S.input, minHeight: '240px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', resize: 'vertical' },
                value: draftText,
                onChange: (e) => setDraftText(e.target.value),
              }),
              h(
                'div',
                { style: { display: 'flex', gap: '6px', marginTop: '8px' } },
                h(
                  'button',
                  { style: S.btn, disabled: ll.busy, onClick: () => ll.mutate('memory', { op: 'write', name: current.name, content: draftText }) },
                  '保存',
                ),
                h('button', { style: S.btn, onClick: () => load(current.name) }, '重载'),
                h(
                  'button',
                  {
                    style: confirmDelete
                      ? { ...S.btn, borderColor: 'currentColor', color: pick('--dsw-alias-state-error-primary') }
                      : { ...S.btn, color: pick('--dsw-alias-state-error-primary') },
                    disabled: ll.busy,
                    title: confirmDelete ? '再点一次确认删除这个记忆文件' : `删除 ${current.name}.md（需要二次确认）`,
                    onClick: async () => {
                      if (!confirmDelete) {
                        setConfirmDelete(true)
                        return
                      }
                      setConfirmDelete(false)
                      await ll.mutate('memory', { op: 'delete', name: current.name })
                      setActive(null)
                    },
                  },
                  confirmDelete ? '确认删除' : '删除',
                ),
              ),
            )
          : null,

        h(
          'div',
          { style: { ...S.dim, marginTop: '10px' } },
          `目录：${ll.state?.paths?.memory ?? ''} —— 纯 markdown，可被 git 跟踪、被编辑器直接改；每轮会以摘要注入模型上下文。`,
        ),
      )
    }

    /* ─────────────────────────────── skills ────────────────────────────── */

    function Skills({ ll }) {
      const skills = ll.state?.skills ?? []
      const [form, setForm] = useState({ name: '', description: '', whenToUse: '', body: '' })
      const [showForm, setShowForm] = useState(false)

      const field = (key) => ({
        style: S.input,
        placeholder: key,
        value: form[key],
        onChange: (e) => setForm({ ...form, [key]: e.target.value }),
      })

      return h(
        'div',
        null,
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' } },
          h('span', { style: S.dim }, `${skills.length} 个工作区 skill`),
          h('button', { style: S.btn, onClick: () => setShowForm((v) => !v) }, showForm ? '收起' : '新建 skill'),
        ),

        showForm
          ? h(
              'div',
              { style: { ...S.card, display: 'flex', flexDirection: 'column', gap: '6px' } },
              h('input', { ...field('name'), placeholder: 'kebab-case 名称' }),
              h('input', { ...field('description'), placeholder: 'description（必填）' }),
              h('input', { ...field('whenToUse'), placeholder: 'whenToUse（可选）' }),
              h('textarea', { ...field('body'), placeholder: '正文 markdown', style: { ...S.input, minHeight: '100px' } }),
              h(
                'button',
                {
                  style: S.btn,
                  disabled: ll.busy,
                  onClick: async () => {
                    const result = await ll.mutate('skill', { op: 'create', ...form })
                    if (result?.ok) {
                      setForm({ name: '', description: '', whenToUse: '', body: '' })
                      setShowForm(false)
                    }
                  },
                },
                '创建',
              ),
            )
          : null,

        skills.map((skill) =>
          h(
            'div',
            { key: skill.name, style: S.card },
            h('div', { style: { fontWeight: 600 } }, skill.name),
            skill.description ? h('div', { style: { ...S.dim, marginTop: '2px' } }, skill.description) : null,
            h('div', { style: { ...S.dim, marginTop: '4px', fontFamily: 'ui-monospace, monospace', fontSize: '11px' } }, skill.path),
          ),
        ),
        skills.length === 0 ? h('div', { style: S.dim }, '还没有工作区 skill。') : null,
        h('div', { style: { ...S.dim, marginTop: '10px' } }, `目录：${ll.state?.paths?.skills ?? ''} —— DSH 的 skill 提供者已经在扫描这个项目根，保存后下一次工具调用即可见。`),
      )
    }

    /* ─────────────────────────────── agents ────────────────────────────── */

    function Agents({ ll }) {
      const agents = ll.state?.agents
      if (agents === undefined || agents.available === false) {
        return h('div', { style: S.dim }, '当前 profile 没有装配 Agent Teams，或还没有活跃团队。')
      }
      if (agents.teams.length === 0) {
        return h('div', { style: S.dim }, '当前没有活跃的多智能体团队。任务板上的 @owner 会显示委派关系。')
      }
      return h(
        'div',
        null,
        agents.teams.map((team) =>
          h(
            'div',
            { key: team.teamId, style: { marginBottom: '14px' } },
            h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, `团队 ${String(team.teamId).slice(0, 12)}`),
            team.members.map((member) =>
              h(
                'div',
                { key: member.name, style: S.row },
                h('span', {
                  style: {
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    flexShrink: 0,
                    background:
                      member.status === 'running'
                        ? pick('--dsw-alias-state-success-primary')
                        : member.status === 'idle'
                          ? pick('--dsw-alias-brand-primary')
                          : pick('--dsw-alias-label-secondary'),
                  },
                }),
                h('span', { style: { flex: 1 } }, member.name),
                h('span', { style: S.chip }, member.role),
                h('span', { style: { ...S.chip, border: 'none' } }, member.status),
              ),
            ),
            team.tasks.length > 0
              ? h(
                  'div',
                  { style: { marginTop: '8px' } },
                  h('div', { style: { ...S.dim, marginBottom: '4px' } }, '共享任务板'),
                  team.tasks.map((task) =>
                    h(
                      'div',
                      { key: task.id, style: S.row },
                      h('span', { style: { ...S.chip, borderColor: task.ready ? 'transparent' : pick('--dsw-alias-state-warn-primary') } }, task.ready ? 'ready' : 'blocked'),
                      h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, task.subject),
                      task.ownerName ? h('span', { style: S.chip }, `@${task.ownerName}`) : null,
                      h('span', { style: { ...S.chip, border: 'none' } }, task.status),
                    ),
                  ),
                  team.tasks.some((t) => t.writeScopeWarnings.length > 0)
                    ? h(
                        'div',
                        { style: { color: pick('--dsw-alias-state-warn-primary'), marginTop: '4px' } },
                        team.tasks.flatMap((t) => t.writeScopeWarnings).join(' · '),
                      )
                    : null,
                )
              : null,
          ),
        ),
      )
    }

    /* ──────────────────────────────── the run ──────────────────────────── */

    const RUN_STATE_LABEL = {
      armed: '已授权',
      running: '运行中',
      paused: '已暂停',
      blocked: '阻塞',
      exhausted: '预算耗尽',
      done: '已完成',
      aborted: '已中止',
    }

    /** One colour per run state, so the tab and the status chip agree at a glance. */
    const RUN_STATE_COLOR = {
      armed: '--dsw-alias-state-success-primary',
      running: '--dsw-alias-state-success-primary',
      paused: '--dsw-alias-state-warn-primary',
      blocked: '--dsw-alias-state-error-primary',
      exhausted: '--dsw-alias-state-error-primary',
      done: '--dsw-alias-state-success-primary',
      aborted: '--dsw-alias-label-secondary',
    }

    const ESCALATION_LABEL = ['', 'L1 提示', 'L2 重规划', 'L3 换模式', 'L4 诊断', 'L5 上报']

    /** §8.3's bands, in the console's words. */
    const CONTEXT_BAND_LABEL = { ok: '充裕', warm: '偏满', hot: '拥挤', unknown: '未测量' }
    const CONTEXT_BAND_COLOR = {
      ok: '--dsw-alias-state-success-primary',
      warm: '--dsw-alias-state-warn-primary',
      hot: '--dsw-alias-state-error-primary',
      unknown: '--dsw-alias-label-secondary',
    }

    function meter(label, ratio, detail) {
      const pct = Math.max(0, Math.min(1, ratio))
      const colour =
        pct >= 0.9
          ? '--dsw-alias-state-error-primary'
          : pct >= 0.7
            ? '--dsw-alias-state-warn-primary'
            : '--dsw-alias-brand-primary'
      return h(
        'div',
        { key: label, style: { marginBottom: '6px' } },
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'space-between', ...S.dim, fontSize: '11px' } },
          h('span', null, label),
          h('span', null, detail),
        ),
        h(
          'div',
          { style: { height: '4px', borderRadius: '2px', background: 'var(--dsw-alias-border-l1, #e5e5e5)', marginTop: '2px' } },
          h('div', { style: { height: '100%', width: `${pct * 100}%`, borderRadius: '2px', background: pick(colour) } }),
        ),
      )
    }

    function Run({ ll }) {
      const run = ll.state?.run
      const [form, setForm] = useState({ objective: '', deliverable: '', acceptance: '', constraints: '', frozenPaths: '', maxRounds: 40 })
      const [showForm, setShowForm] = useState(false)
      const [confirmStop, setConfirmStop] = useState(false)

      // Aborting a run is not undoable, so it takes two clicks; the first expires.
      useEffect(() => {
        if (!confirmStop) return undefined
        const timer = window.setTimeout(() => setConfirmStop(false), 5000)
        return () => window.clearTimeout(timer)
      }, [confirmStop])

      const act = (op, extra) => ll.mutate('run', { op, ...extra })

      if (run === undefined) {
        const criteria = parseAcceptanceLines(form.acceptance)
        const checkableCount = criteria.filter((criterion) => criterion.check !== undefined).length
        const canStart = !ll.busy && form.objective.trim().length > 0 && criteria.length > 0
        const blockedBy = ll.busy
          ? '正在与宿主通信'
          : form.objective.trim().length === 0
            ? '先写目标'
            : criteria.length === 0
              ? '至少写一条验收标准'
              : undefined

        return h(
          'div',
          null,
          h(
            'div',
            { style: { ...S.card, borderColor: pick('--dsw-alias-brand-primary') } },
            h('div', { style: { fontWeight: 600 } }, '新建运行'),
            h(
              'div',
              { style: { ...S.dim, fontSize: '11px', marginTop: '2px' } },
              '一个运行 = 目标 + 一份开工即冻结的验收契约。契约决定"做完"的判据，运行期间执行者改不了它。',
            ),
          ),
          h(
            'div',
            { style: { ...S.card, marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '6px' } },
            h('span', { style: { ...S.dim, fontSize: '11px' } }, '目标'),
            h('textarea', {
              style: { ...S.input, minHeight: '46px' },
              placeholder: '这个运行要达成什么（一句话，可执行的那种）',
              value: form.objective,
              onChange: (e) => setForm({ ...form, objective: e.target.value }),
            }),
            h('span', { style: { ...S.dim, fontSize: '11px' } }, '交付物（可选）'),
            h('input', {
              style: S.input,
              placeholder: '交付什么物：文件 / 命令 / 报告',
              value: form.deliverable,
              onChange: (e) => setForm({ ...form, deliverable: e.target.value }),
            }),
            h('span', { style: { ...S.dim, fontSize: '11px' } }, '验收标准 · 一行一条'),
            h('textarea', {
              style: { ...S.input, minHeight: '86px', fontFamily: 'ui-monospace, monospace', fontSize: '11px' },
              placeholder: [
                '检查通过的测试全绿 | node --test tests/ | 退出码 0',
                'README 提到新接口 |  | 文件 README.md',
                '构建不报错 | npm run build | 退出码 0',
                '（只写陈述也可以，但那样它无法被机器判定）',
              ].join('\n'),
              title: '每行：陈述 | 命令 | 期望。期望写法：退出码 0 / stdout /正则/ / 文件 path',
              value: form.acceptance,
              onChange: (e) => setForm({ ...form, acceptance: e.target.value }),
            }),
            h(
              'div',
              { style: { ...S.dim, fontSize: '11px' } },
              criteria.length === 0
                ? '还没有标准。没有验收标准的运行跑不到"完成"，只会跑到预算耗尽。'
                : `${criteria.length} 条标准 · 其中 ${checkableCount} 条可机器判定` +
                    (checkableCount === 0 ? '（没有可执行的检查，验证只能停在声明层面）' : ''),
            ),
            criteria.length > 0 && checkableCount > 0
              ? h(
                  'div',
                  { style: { ...S.dim, fontSize: '11px', fontFamily: 'ui-monospace, monospace' } },
                  criteria
                    .filter((criterion) => criterion.check !== undefined)
                    .map((criterion) => `$ ${criterion.check.command}`)
                    .join('\n')
                    .split('\n')
                    .slice(0, 4)
                    .join('　'),
                )
              : null,
            h('span', { style: { ...S.dim, fontSize: '11px' } }, '硬约束（可选，一行一条）'),
            h('textarea', {
              style: { ...S.input, minHeight: '44px' },
              placeholder: '不许改 public API\n不许加新依赖',
              value: form.constraints,
              onChange: (e) => setForm({ ...form, constraints: e.target.value }),
            }),
            h(
              'span',
              { style: { ...S.dim, fontSize: '11px' }, title: '§8.4 契约冻结：列在这里的文件在整个运行期间受 tools.guard 写保护' },
              '冻结文件（可选，一行一条）· 执行者不能改它们',
            ),
            h('textarea', {
              style: { ...S.input, minHeight: '44px' },
              placeholder: 'tests/api.test.ts\n（把上面那些命令所在的测试文件写进来，否则运行能改自己的判卷）',
              value: form.frozenPaths,
              onChange: (e) => setForm({ ...form, frozenPaths: e.target.value }),
            }),
            h(
              'div',
              { style: { display: 'flex', gap: '6px', alignItems: 'center', marginTop: '2px' } },
              h('input', {
                style: { ...S.input, width: '92px' },
                type: 'number',
                min: 1,
                value: form.maxRounds,
                onChange: (e) => setForm({ ...form, maxRounds: Number(e.target.value) }),
              }),
              h('span', { style: S.dim }, '轮数上限'),
              h(
                'button',
                {
                  style: { ...S.btn, ...(canStart ? S.btnPrimary ?? {} : { opacity: 0.5 }), marginLeft: 'auto' },
                  disabled: !canStart,
                  title: blockedBy ?? '创建并冻结契约',
                  onClick: () =>
                    act('start', {
                      objective: form.objective,
                      contract: {
                        deliverable: form.deliverable,
                        acceptance: criteria,
                        constraints: form.constraints.split('\n').filter((line) => line.trim().length > 0),
                        frozenPaths: form.frozenPaths.split('\n').filter((line) => line.trim().length > 0),
                      },
                      maxRounds: form.maxRounds,
                    }),
                },
                canStart ? '创建运行' : `还不能创建 · ${blockedBy}`,
              ),
            ),
          ),
        )
      }

      const terminal = ['blocked', 'exhausted', 'done', 'aborted'].includes(run.state)
      const acceptance = run.contract?.acceptance ?? []
      const checkable = acceptance.filter((criterion) => criterion.check?.command).length
      const health = ll.state?.context

      return h(
        'div',
        null,
        h(
          'div',
          { style: { ...S.card, display: 'flex', flexDirection: 'column', gap: '6px' } },
          h(
            'div',
            { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
            h('span', { style: { ...S.chip, borderColor: 'currentColor', color: pick(RUN_STATE_COLOR[run.state] ?? '--dsw-alias-label-secondary') }, title: `运行状态：${RUN_STATE_LABEL[run.state] ?? run.state}` }, RUN_STATE_LABEL[run.state] ?? run.state),
            h('span', { style: { ...S.dim, fontFamily: 'ui-monospace, monospace' } }, run.id),
            h(
              'span',
              {
                style: { ...S.chip, border: 'none' },
                title: '验证档：self 只记声明 / executable 跑冻结的检查 / independent 再加一个无共享上下文的评估器',
              },
              `验证 ${run.assurance ?? 'executable'}`,
            ),
            h(
              'span',
              {
                style: {
                  ...S.chip,
                  borderColor: 'currentColor',
                  color: pick(run.mode === 'fresh' ? '--dsw-alias-state-warn-primary' : '--dsw-alias-label-secondary'),
                },
                title:
                  run.mode === 'fresh'
                    ? 'L3 已生效：每一轮交给一个全新会话执行，它只带契约与状态，不带被污染的上下文'
                    : 'inline：在同一个会话里续跑',
              },
              run.mode === 'fresh' ? '换模式' : 'inline',
            ),
            h('span', { style: { ...S.dim, marginLeft: 'auto' } }, `第 ${run.round}/${run.maxRounds} 轮`),
          ),
          h('div', { style: { fontWeight: 600 } }, run.objective),
          run.endedAt
            ? h('div', { style: { color: pick('--dsw-alias-state-warn-primary'), fontSize: '12px' } }, `结束原因：${run.endReason ?? '—'}`)
            : null,
        ),

        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: { display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '6px' } },
            h('div', { style: { ...S.dim, fontSize: '11px' } }, '验收标准（冻结）'),
            h(
              'span',
              { style: { ...S.dim, fontSize: '11px', marginLeft: 'auto' }, title: '只有带命令的标准能被机器判定；其余只能由独立评估器或人工裁决' },
              acceptance.length === 0
                ? '没有标准 → 无法验证'
                : `可机器判定 ${checkable}/${acceptance.length}`,
            ),
          ),
          acceptance.length === 0
            ? h('div', { style: { color: pick('--dsw-alias-state-warn-primary'), fontSize: '12px' } }, '这个运行没有验收标准，只会跑到预算耗尽。')
            : null,
          (run.contract?.frozenPaths ?? []).length > 0
            ? h(
                'div',
                { style: { ...S.dim, fontSize: '11px', marginTop: '4px' }, title: '§8.4 契约冻结：这些文件在运行期间受 tools.guard 写保护' },
                `冻结文件（执行者不可改）：${(run.contract.frozenPaths ?? []).join(' · ')}`,
              )
            : h(
                'div',
                { style: { color: pick('--dsw-alias-state-warn-primary'), fontSize: '11px', marginTop: '4px' } },
                '没有冻结任何文件 —— 这个运行改得动自己的验收测试。',
              ),
          // §8.6: a round that was dispatched and never reported back. Until it is
          // reconciled, the loop is not free to replay side effects.
          run.unknownOutcomeRoundId !== undefined
            ? h(
                'div',
                {
                  style: { ...S.card, marginTop: '6px', borderColor: pick('--dsw-alias-state-warn-primary'), fontSize: '11px' },
                  title: '恢复纪律：先核对状态，不要盲目重放副作用（§8.6）',
                },
                `上一次派发（${run.unknownOutcomeRoundId}）结果未知（进程中断）。副作用可能已发生，也可能没有 —— 重新授权后的第一轮带着这条提醒，先核对文件 / git 状态再动手。`,
              )
            : null,
          // §8.4: a criterion stored without the expectation it was written with
          // looks decidable and is not. Say it out loud.
          (run.contractWarnings ?? []).length > 0
            ? h(
                'div',
                {
                  style: { ...S.card, marginTop: '6px', borderColor: pick('--dsw-alias-state-warn-primary'), fontSize: '11px' },
                  title: '契约在创建时做了降级',
                },
                `契约警告 ${run.contractWarnings.length} 条：\n` + run.contractWarnings.join('\n'),
              )
            : null,
          acceptance.map((criterion, index) =>
            h(
              'div',
              { key: criterion.id ?? index, style: { marginBottom: '6px' } },
              h(
                'div',
                { style: { display: 'flex', gap: '6px', alignItems: 'baseline' } },
                h(
                  'span',
                  {
                    style: {
                      ...S.chip,
                      border: 'none',
                      color: pick(criterion.weight === 'nice-to-have' ? '--dsw-alias-label-secondary' : '--dsw-alias-label-primary'),
                    },
                    title: criterion.weight === 'nice-to-have' ? '非必达：不影响完成判定' : '必达：决定运行是否完成',
                  },
                  criterion.weight === 'nice-to-have' ? '非必达' : '必达',
                ),
                h('span', { style: { flex: 1, fontSize: '12px' } }, criterion.statement),
                h('span', { style: { ...S.dim, fontSize: '11px', fontFamily: 'ui-monospace, monospace' } }, criterion.id ?? ''),
              ),
              criterion.check?.command
                ? h(
                    'div',
                    { style: { ...S.dim, fontSize: '11px', fontFamily: 'ui-monospace, monospace', marginTop: '2px', wordBreak: 'break-all' } },
                    `$ ${criterion.check.command}  → ${describeExpect(criterion.check.expect)}`,
                  )
                : h(
                    'div',
                    { style: { color: pick('--dsw-alias-state-warn-primary'), fontSize: '11px', marginTop: '2px' } },
                    '没有可执行检查 —— 机器无法判定，只能靠独立评估器或人工确认。',
                  ),
            ),
          ),
        ),

        h(
          'div',
          { style: S.card },
          h('div', { style: { ...S.dim, marginBottom: '6px', fontSize: '11px' } }, '预算'),
          (run.budget?.dimensions ?? []).map((d) => {
            const label =
              d.name === 'rounds' ? '轮数' : d.name === 'wallClockMs' ? '墙钟' : d.name === 'tokens' ? 'Token' : d.name
            const used =
              d.name === 'wallClockMs'
                ? `${formatDuration(d.used)} / ${formatDuration(d.limit)}`
                : `${d.used}/${d.limit}`
            return meter(label, d.ratio, `${used} · ${(d.ratio * 100).toFixed(0)}%`)
          }),
          run.budget?.rung
            ? h('div', { style: { color: pick('--dsw-alias-state-warn-primary'), fontSize: '12px', marginTop: '4px' } }, `已进入降级档：${run.budget.rung}`)
            : null,
        ),

        run.stalledRounds > 0
          ? h(
              'div',
              { style: { ...S.card, borderColor: pick('--dsw-alias-state-warn-primary') } },
              h('div', { style: { fontWeight: 600, color: pick('--dsw-alias-state-warn-primary') } }, `停滞 ${run.stalledRounds} 轮 · ${ESCALATION_LABEL[run.escalation?.level ?? 0] || '—'}`),
              h('div', { style: { ...S.dim, marginTop: '4px' } }, run.escalation?.directive ?? ''),
            )
          : null,

        // ── §8.3 context health, and §4 A1's durable mirror ──────────────────
        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: { display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '6px' } },
            h('div', { style: { ...S.dim, fontSize: '11px' } }, '上下文与日志'),
            h(
              'span',
              {
                style: {
                  ...S.chip,
                  borderColor: 'currentColor',
                  color: pick(CONTEXT_BAND_COLOR[health?.band] ?? CONTEXT_BAND_COLOR.unknown),
                },
                title: '§8.3 上下文健康度：压力达到 70% 时，驱动会在下一轮开始前主动压缩，而不是等自动触发',
              },
              CONTEXT_BAND_LABEL[health?.band] ?? CONTEXT_BAND_LABEL.unknown,
            ),
            h(
              'span',
              { style: { ...S.dim, marginLeft: 'auto', fontSize: '11px' } },
              health?.measured === true
                ? `${health.pressureTokens.toLocaleString('en-US')} / ${health.contextWindow.toLocaleString('en-US')} tok`
                : '没有可用的上下文计量',
            ),
          ),
          health?.measured === true
            ? meter('压力', health.ratio, `${(health.ratio * 100).toFixed(1)}% · 健康 ${health.health.toFixed(2)}`)
            : null,
          (health?.reasons ?? []).map((reason, index) =>
            h('div', { key: index, style: { ...S.dim, fontSize: '11px', marginTop: '2px' } }, `· ${reason}`),
          ),
          // §8.4: what the loop will actually do about drift and about the answer
          // it must not read. Shown as configuration because that is what it is.
          h(
            'div',
            { style: { ...S.dim, fontSize: '11px', marginTop: '6px' } },
            `治理：过程抽查每 ${ll.state?.governance?.processVerifyEveryRounds ?? '—'} 轮` +
              ` · 冻结写保护 ${ll.state?.governance?.frozenGuard === true ? '开' : '关'}` +
              ` · 检疫名单 ${ll.state?.governance?.quarantine?.names ?? '—'} 项/${ll.state?.governance?.quarantine?.suffixes ?? '—'} 后缀`,
          ),
          run?.processVerifyRound > 0
            ? h(
                'div',
                { style: { ...S.dim, fontSize: '11px', marginTop: '2px' } },
                `最近一次过程抽查：第 ${run.processVerifyRound} 轮 · ` +
                  `${run.lastProcessVerdict?.status ?? '—'}（不是完成裁决）` +
                  (run.lastProcessVerdict?.quarantine?.errors > 0
                    ? ` · 检疫扫描有 ${run.lastProcessVerdict.quarantine.errors} 处没读到`
                    : ' · 检疫扫描已读完整棵树'),
              )
            : null,
          ll.state?.projections === undefined
            ? h(
                'div',
                { style: { ...S.dim, fontSize: '11px', marginTop: '6px' }, title: ll.state?.projectionReason ?? undefined },
                `会话日志投影不可用：${ll.state?.projectionReason ?? '原因未上报'}。事实仍落在 .longloop/ 文件里。`,
              )
            : h(
                'div',
                { style: { ...S.dim, fontSize: '11px', marginTop: '6px' } },
                `会话日志：已镜像 ${ll.state.projections.rounds?.count ?? 0} 轮 · ${ll.state.projections.ledger?.count ?? 0} 条台账` +
                  `（${Object.entries(ll.state.projections.ledger?.byKind ?? {}).map(([kind, count]) => `${kind} ${count}`).join(' · ') || '暂无'}）`,
              ),
        ),

        run.diagnosis !== undefined
          ? h(
              'div',
              { style: { ...S.card, borderColor: pick('--dsw-alias-brand-primary') } },
              h('div', { style: { fontWeight: 600, color: pick('--dsw-alias-brand-primary') } }, '独立诊断（L4）'),
              h('div', { style: { marginTop: '4px', fontSize: '12px' } }, `阻塞：${run.diagnosis.blocker}`),
              h('div', { style: { fontSize: '12px' } }, `站不住的假设：${run.diagnosis.falseAssumption}`),
              h('div', { style: { fontSize: '12px' } }, `下一步：${run.diagnosis.nextAction}`),
              run.diagnosis.evidence ? h('div', { style: { ...S.dim, fontSize: '11px' } }, `依据：${run.diagnosis.evidence}`) : null,
            )
          : null,

        (run.constraints ?? []).length > 0
          ? h(
              'div',
              { style: S.card },
              h('div', { style: { ...S.dim, marginBottom: '4px', fontSize: '11px' } }, `钉住的约束 ${run.constraints.length} 条（压缩不会带走它们）`),
              run.constraints.slice(-6).map((c, i) =>
                h('div', { key: i, style: { fontSize: '12px' } }, h('span', { style: { ...S.chip, border: 'none' } }, c.kind), ` ${c.text}`),
              ),
            )
          : null,

        terminal && run.handoff !== undefined
          ? h(
              'div',
              { style: S.card },
              h('div', { style: { fontWeight: 600 } }, '交接包已生成'),
              h('div', { style: { ...S.dim, fontSize: '11px', fontFamily: 'ui-monospace, monospace' } }, run.handoff.path ?? ''),
            )
          : null,

        acceptance.length > 0
          ? h(
              'div',
              { style: S.card },
              h('div', { style: { ...S.dim, marginBottom: '4px', fontSize: '11px' } }, '验收标准（已在开工时冻结，执行者不能改）'),
              acceptance.map((c, i) =>
                h(
                  'div',
                  { key: i, style: { marginBottom: '4px' } },
                  h(
                    'div',
                    { style: { display: 'flex', gap: '6px' } },
                    h('span', { style: { ...S.chip, border: 'none' } }, c.weight === 'nice-to-have' ? '次要' : '必达'),
                    h('span', null, c.statement),
                    c.check === undefined
                      ? h('span', { style: { ...S.chip, color: pick('--dsw-alias-state-warn-primary'), borderColor: 'currentColor' }, title: '没有可执行检查，只能人工复核' }, '无检查')
                      : h('span', { style: { ...S.chip, color: pick('--dsw-alias-brand-primary'), borderColor: 'currentColor' } }, '可验证'),
                  ),
                  c.check !== undefined
                    ? h('div', { style: { ...S.dim, fontSize: '11px', fontFamily: 'ui-monospace, monospace', marginLeft: '4px' } }, `$ ${c.check.command}`)
                    : null,
                ),
              ),
            )
          : h('div', { style: { ...S.card, borderColor: pick('--dsw-alias-state-warn-primary'), color: pick('--dsw-alias-state-warn-primary') } }, '这条运行没有验收标准，无法被验证。'),

        run.lastVerdict !== undefined
          ? h(
              'div',
              {
                style: {
                  ...S.card,
                  borderColor: pick(run.lastVerdict.status === 'pass' ? '--dsw-alias-state-success-primary' : '--dsw-alias-state-error-primary'),
                },
              },
              h(
                'div',
                { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
                h('strong', null, '最近裁决'),
                h(
                  'span',
                  {
                    style: {
                      ...S.chip,
                      borderColor: 'currentColor',
                      color: pick(run.lastVerdict.status === 'pass' ? '--dsw-alias-state-success-primary' : '--dsw-alias-state-error-primary'),
                    },
                  },
                  run.lastVerdict.status,
                ),
                h('span', { style: { ...S.dim, marginLeft: 'auto', fontSize: '11px' } }, `${run.lastVerdict.level} · 第 ${run.lastVerdict.round} 轮 · ${run.lastVerdict.id}`),
              ),
              run.lastVerdict.merged === 'two-layer'
                ? h('div', { style: { ...S.dim, fontSize: '11px', marginTop: '2px' } }, '确定性与独立评估器两层合并')
                : run.lastVerdict.level === 'executable'
                  ? h('div', { style: { ...S.dim, fontSize: '11px', marginTop: '2px' } }, '仅确定性检查（独立评估器不可用或本档未启用）')
                  : null,
              run.lastVerdict.independentSummary ?? run.lastVerdict.summary
                ? h('div', { style: { marginTop: '4px', fontSize: '12px' } }, run.lastVerdict.independentSummary ?? run.lastVerdict.summary)
                : null,
              (run.lastVerdict.perCriterion ?? []).map((c, i) =>
                h(
                  'div',
                  { key: i, style: { marginTop: '4px', fontSize: '12px' } },
                  h(
                    'span',
                    {
                      style: {
                        ...S.chip,
                        border: 'none',
                        color: pick(
                          c.status === 'pass'
                            ? '--dsw-alias-state-success-primary'
                            : c.status === 'fail'
                              ? '--dsw-alias-state-error-primary'
                              : '--dsw-alias-label-secondary',
                        ),
                      },
                    },
                    c.status,
                  ),
                  ` ${c.id} ${c.statement}`,
                  h('div', { style: { ...S.dim, fontSize: '11px', marginLeft: '4px' } }, c.note),
                ),
              ),
              run.lastVerdict.sideEffects === true
                ? h('div', { style: { ...S.dim, marginTop: '4px', fontSize: '11px' } }, '（检查过程改动了工作区，已在证据里记录）')
                : null,
            )
          : null,

        run.challenges > 0
          ? h('div', { style: { ...S.dim, marginTop: '4px', fontSize: '11px' } }, `验证门已把完成声明退回 ${run.challenges} 次（上限 2 次，超过即按可判定结果裁决）。`)
          : null,

        run.lastBlockers?.length > 0
          ? h(
              'div',
              { style: S.card },
              h('div', { style: { ...S.dim, marginBottom: '4px', fontSize: '11px' } }, '阻塞记录'),
              run.lastBlockers.slice(-3).map((b, i) =>
                h('div', { key: i, style: { marginBottom: '4px' } }, h('div', null, b.blocker), h('div', { style: { ...S.dim, fontSize: '11px' } }, `已试：${(b.attempted ?? []).join(' · ') || '—'}`)),
              ),
            )
          : null,

        h(
          'div',
          { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
          run.state === 'armed' && !terminal
            ? h('button', { style: S.btn, disabled: ll.busy, onClick: () => act('pause') }, '暂停')
            : null,
          run.state === 'paused'
            ? h('button', { style: { ...S.btn, borderColor: pick('--dsw-alias-brand-primary') }, disabled: ll.busy, onClick: () => act('arm') }, '授权继续')
            : null,
          !terminal ? h('button', { style: S.btn, disabled: ll.busy, onClick: () => act('assess') }, '评估本轮') : null,
          !terminal
            ? h(
                'button',
                {
                  style: S.btn,
                  disabled: ll.busy,
                  title: '有些验收标准没有可执行检查，机器无法判定。人工复核是合法的裁决来源。',
                  onClick: () => act('verify', { by: 'human', who: '控制台' }),
                },
                '人工确认完成',
              )
            : null,
          !terminal
            ? confirmStop
              ? h(
                  'button',
                  {
                    style: { ...S.btn, borderColor: 'currentColor', color: pick('--dsw-alias-state-error-primary') },
                    disabled: ll.busy,
                    title: '再点一次确认中止；运行会转入 aborted，不可恢复',
                    onClick: () => {
                      setConfirmStop(false)
                      act('stop', { reason: '人手中止' })
                    },
                  },
                  '确认中止',
                )
              : h(
                  'button',
                  {
                    style: { ...S.btn, color: pick('--dsw-alias-state-error-primary') },
                    disabled: ll.busy,
                    title: '中止运行（需要二次确认）',
                    onClick: () => setConfirmStop(true),
                  },
                  '中止',
                )
            : h(
                'button',
                {
                  style: S.btn,
                  disabled: ll.busy,
                  title: '用同一个目标与契约重开一个运行（契约不重新填写）',
                  onClick: () => act('start', { objective: run.objective, contract: run.contract, maxRounds: run.maxRounds, assurance: run.assurance }),
                },
                '重新开始',
              ),
        ),

        ll.state?.driverEnabled === false
          ? h(
              'div',
              { style: { ...S.dim, marginTop: '8px', fontSize: '11px' } },
              '自动续跑未启用（config.driver: false）。当前只有人点「评估本轮」才会推进治理状态；要让循环自己跑，在 profile 的 cordis.patch.yml 里把 driver 设为 true。',
            )
          : null,

        h('div', { style: { ...S.dim, marginTop: '8px', fontSize: '11px' } }, `文件：${ll.state?.paths?.run ?? ''}`),
      )
    }

    /* ─────────────────────────────── the panel ─────────────────────────── */

    const WIDTH_KEY = 'longloop-console.width'
    const MIN_WIDTH = 380
    const MAX_WIDTH = 900
    const DEFAULT_WIDTH = 460

    /**
     * Drawer width in px, remembered across reloads.
     *
     * The console is a tool a human keeps open beside a session, so the width is
     * worth remembering: `.longloop/` paths and verdict notes are wide, and 460px
     * is only a sane first guess. Private-mode storage failures fall back to the
     * default — the width is a nicety, never console state.
     */
    function usePanelWidth() {
      const [width, setWidth] = useState(() => {
        try {
          const saved = Number(window.localStorage.getItem(WIDTH_KEY))
          return Number.isFinite(saved) && saved >= MIN_WIDTH ? Math.min(saved, MAX_WIDTH) : DEFAULT_WIDTH
        } catch {
          return DEFAULT_WIDTH
        }
      })
      useEffect(() => {
        try {
          window.localStorage.setItem(WIDTH_KEY, String(width))
        } catch {
          /* storage unavailable: the drawer simply forgets its width */
        }
      }, [width])
      return [width, setWidth]
    }

    /** Left-edge drag handle; double-click restores the default width. */
    function WidthHandle({ width, setWidth }) {
      const drag = useRef(null)

      useEffect(() => {
        const move = (event) => {
          if (drag.current === null) return
          const next = drag.current.width + (drag.current.x - event.clientX)
          setWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, next)))
        }
        const stop = () => {
          drag.current = null
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', stop)
        return () => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', stop)
        }
      }, [setWidth])

      return h('div', {
        role: 'separator',
        'aria-orientation': 'vertical',
        'aria-label': '拖动调整控制台宽度',
        title: '拖动调整宽度，双击恢复默认',
        onMouseDown: (event) => {
          event.preventDefault()
          drag.current = { x: event.clientX, width }
        },
        onDoubleClick: () => setWidth(DEFAULT_WIDTH),
        style: {
          position: 'absolute',
          left: 0,
          top: 0,
          width: '7px',
          height: '100%',
          cursor: 'col-resize',
          zIndex: 2,
        },
      })
    }

    const TABS = [
      ['run', '循环'],
      ['tasks', '任务'],
      ['memory', '记忆'],
      ['skills', 'Skill'],
      ['agents', '智能体'],
    ]

    function Console() {
      const isOpen = useOpen()
      const ll = useLongLoop()
      const [tab, setTab] = useState('tasks')
      const [width, setWidth] = usePanelWidth()
      // Set by the tab buttons only: an explicit choice outranks the automatic
      // landing spot below.
      const [tabTouched, setTabTouched] = useState(false)
      // A workspace with no run has exactly one useful thing to do, and the
      // create form is it: open on the loop tab rather than on an empty task
      // board. This positions the drawer **once per open**, after the first
      // state arrives — an effect keyed on the run would also fire when the user
      // creates a run and yank them off the page they just filled in.
      const [positioned, setPositioned] = useState(false)
      const stateReady = ll.state !== undefined
      const hasRun = ll.state?.run !== undefined
      useEffect(() => {
        if (!isOpen) {
          setPositioned(false)
          return
        }
        if (positioned || tabTouched || !stateReady) return
        setTab(hasRun ? 'tasks' : 'run')
        setPositioned(true)
      }, [isOpen, positioned, tabTouched, stateReady, hasRun])

      // Esc closes the drawer — except while typing, where Esc belongs to the
      // editor (the task-title input and the memory textarea use it too).
      useEffect(() => {
        if (!isOpen) return undefined
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          const tag = (event.target?.tagName ?? '').toLowerCase()
          if (tag === 'input' || tag === 'textarea' || event.target?.isContentEditable) return
          store.set(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [isOpen])

      if (!isOpen) return null

      const run = ll.state?.run
      const tasks = ll.state?.tasks ?? []
      const openTasks = tasks.filter((t) => t.status === 'pending' || t.status === 'in_progress' || t.status === 'blocked').length
      const members = (ll.state?.agents?.teams ?? []).reduce((total, team) => total + team.members.length, 0)
      const counts = {
        run: run === undefined ? null : run.round,
        tasks: openTasks,
        memory: (ll.state?.memory ?? []).length,
        skills: (ll.state?.skills ?? []).length,
        agents: members,
      }

      return h(
        'div',
        { style: { ...S.panel, width: `${width}px` }, role: 'complementary', 'aria-label': '长任务控制台' },
        h(WidthHandle, { width, setWidth }),
        h(
          'div',
          { style: S.head },
          h('strong', { style: { flex: 1 } }, '任务台'),
          h(
            'span',
            { style: { ...S.dim, fontSize: '11px' }, title: '每 5 秒自动刷新' },
            ll.updatedAt === null ? '读取中…' : `${new Date(ll.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })} 更新`,
          ),
          h('button', { style: S.btn, onClick: () => ll.reload(), disabled: ll.busy, title: '立即刷新' }, '刷新'),
          ll.state?.workspace
            ? h(
                'select',
                {
                  style: { ...S.input, width: 'auto', maxWidth: '170px' },
                  title: '切换控制台指向的工作区',
                  value: ll.state.workspace.path,
                  onChange: (e) => ll.setWorkspace(e.target.value),
                },
                (ll.state.workspaces ?? []).map((w) => h('option', { key: w.path, value: w.path }, w.title || w.path)),
              )
            : null,
          h('button', { style: S.btn, onClick: () => store.set(false), 'aria-label': '关闭', title: '关闭（Esc）' }, '关闭'),
        ),

        h(
          'div',
          { style: S.tabs },
          TABS.map(([key, label]) =>
            h(
              'button',
              {
                key,
                style: {
                  ...S.btn,
                  display: 'inline-flex',
                  alignItems: 'center',
                  background: tab === key ? 'var(--dsw-alias-bg-base, #fff)' : 'transparent',
                  borderColor: tab === key ? pick('--dsw-alias-brand-primary') : 'transparent',
                },
                onClick: () => {
                  setTabTouched(true)
                  setTab(key)
                },
              },
              label,
              key === 'run' && run !== undefined
                ? h('span', {
                    style: { ...S.dot, background: pick(RUN_STATE_COLOR[run.state] ?? '--dsw-alias-label-secondary') },
                    title: `运行状态：${RUN_STATE_LABEL[run.state] ?? run.state}`,
                  })
                : null,
              key !== 'run' && counts[key] > 0 ? h('span', { style: S.badge }, counts[key]) : null,
            ),
          ),
        ),

        h(
          'div',
          { style: S.body },
          ll.error ? h('div', { style: S.err }, ll.error, h('button', { style: { ...S.btn, marginLeft: '8px' }, onClick: () => ll.setError(null) }, '忽略')) : null,
          ll.state === null ? h('div', { style: S.dim }, '读取中…') : null,
          ll.state !== null && tab === 'run'
            ? h('div', null, h(Run, { ll }), h(MetricsCard, { workspace: ll.state?.workspace?.path }))
            : null,
          ll.state !== null && tab === 'tasks' ? h(TaskBoard, { ll }) : null,
          ll.state !== null && tab === 'memory' ? h(Memory, { ll }) : null,
          ll.state !== null && tab === 'skills' ? h(Skills, { ll }) : null,
          ll.state !== null && tab === 'agents' ? h(Agents, { ll }) : null,
        ),
      )
    }

    /* ──────────────────────────── header trigger ───────────────────────── */

    function Trigger() {
      const isOpen = useOpen()
      return h(
        'button',
        {
          style: {
            font: 'inherit',
            padding: '3px 9px',
            borderRadius: '6px',
            border: `1px solid ${isOpen ? pick('--dsw-alias-brand-primary') : 'var(--dsw-alias-border-l2, #ccc)'}`,
            background: 'transparent',
            color: isOpen ? pick('--dsw-alias-brand-primary') : 'inherit',
            cursor: 'pointer',
          },
          title: '打开长任务控制台：任务板 / 工作区记忆 / Skill / 多智能体',
          onClick: () => store.set(!isOpen),
        },
        '任务台',
      )
    }

    /**
     * Glyph-only trigger for `sidebar.panellist`.
     *
     * That slot renders the component inside the icon cell and prints the entry's
     * own `label` beside it, so the text button above would show "任务台 任务台".
     * The sidebar passes `{ size, active }`.
     */
    function PanelIcon({ size = 18, active } = {}) {
      const isOpen = useOpen()
      // The row is a panel SELECTOR (`selectPanel(id)`), and our console lives in
      // a shell overlay of its own, so the glyph toggles the console directly:
      // letting the row's own click through would open the layout's panel host
      // for an id that has no page (an empty pane) instead.
      return h(
        'span',
        {
          'data-longloop-trigger': 'sidebar',
          title: '打开长任务控制台：任务板 / 工作区记忆 / Skill / 多智能体',
          onClick: (event) => {
            event.stopPropagation()
            store.set(!isOpen)
          },
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            color: isOpen || active ? pick('--dsw-alias-brand-primary') : 'currentColor',
          },
        },
        h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 16 16',
            fill: 'none',
            'aria-hidden': 'true',
            style: { display: 'block', color: 'currentColor' },
          },
          h('path', {
            d: 'M2 3.5h12M2 8h12M2 12.5h7',
            stroke: 'currentColor',
            strokeWidth: 1.4,
            strokeLinecap: 'round',
          }),
        ),
      )
    }

    /**
     * Make the whole sidebar row work, not only the 16px glyph.
     *
     * `sidebar.panellist` renders this plugin as a panel *selector* row: clicking
     * the row calls the layout's `selectPanel(id)`, which opens an empty pane,
     * because this plugin's console is a shell overlay and not a panel page. Only
     * the glyph carried our handler, so clicking the words "任务台" — the obvious
     * thing to click — did nothing useful.
     *
     * The interceptor runs in the capture phase on `document`, i.e. before React's
     * root listener, so `stopPropagation` here means the layout's `selectPanel`
     * never fires. Matching on the row's `aria-label` rather than on the glyph
     * also covers keyboard activation, where the click target is the button.
     */
    function bindSidebarRow() {
      const onCapture = (event) => {
        const target = event.target
        if (!(target instanceof Element)) return
        const row = target.closest('button')
        if (row === null) return
        // Identity, not geometry: the row is ours because it contains the glyph
        // this plugin injected. Matching on the slot wrapper instead would miss
        // the label text, which sits beside that wrapper, not inside it.
        const ours = row.querySelector('[data-longloop-trigger]') !== null || row.getAttribute('aria-label') === PANEL_LABEL
        if (!ours) return
        event.preventDefault()
        event.stopPropagation()
        store.set(!store.isOpen())
      }
      document.addEventListener('click', onCapture, true)
      return () => document.removeEventListener('click', onCapture, true)
    }

    /* ─────────────────────────────── plugin ────────────────────────────── */

    return {
      inject: ['slots'],
      apply(ctx) {
        // `slots.inject(slot, cb)` is the only way to attach to a slot another
        // plugin declares. A raw `register` into an undeclared slot throws:
        //
        //   slot "sidebar.panellist" is not declared
        //   (a parent entry's children table must declare it)
        //
        // — which is why the console had no entry point at all: both triggers are
        // declared by the layout/sidebar plugins, and the failure was swallowed.
        // `shell.overlay` is root-declared, so it mounts either way.
        ctx.effect(
          () =>
            ctx.slots.inject('shell.overlay', () =>
              ctx.slots.register({ name: 'shell.overlay', id: 'longloop-console', order: 40, label: '长任务控制台' }, Console),
            ),
          'longloop-console.overlay',
        )
        const attachTrigger = (slot, component) =>
          ctx.effect(
            () =>
              ctx.slots.inject(slot, () =>
                ctx.slots.register({ name: slot, id: 'longloop-console', order: 40, label: PANEL_LABEL }, component),
              ),
            `longloop-console.trigger:${slot}`,
          )
        attachTrigger('conversation.session.header.utilities', Trigger)
        attachTrigger('sidebar.panellist', PanelIcon)
        ctx.effect(() => bindSidebarRow())
      },
    }
  },
})
