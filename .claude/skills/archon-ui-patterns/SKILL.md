---
name: archon-ui-patterns
description: Concrete UI component and layout patterns for developer dashboards, agent orchestration interfaces, and workflow tools. Use when building status boards, streaming logs, task kanbans, DAG visualizations, metric charts, or review gate UIs. Defines implementation-ready patterns drawn from best-in-class tools (Langfuse, Linear, Vercel, LangSmith).
---

# Archon UI Patterns

Use this skill when implementing specific UI components or layout patterns for developer and agent orchestration dashboards.

Goal: produce patterns that are information-dense, technically credible, and immediately useful — not marketing-style mockups.

---

## Recommended Frontend Stack

For all new frontend surfaces built with or for Archon:

| Layer | Choice | Rationale |
|---|---|---|
| Build | Vite 6 | Instant HMR, no SSR overhead for auth-only dashboards |
| Framework | React 19 | Ecosystem depth (React Flow, Tremor, TanStack) — non-negotiable |
| Routing | TanStack Router v2 | Type-safe params/search, file-based, best for complex SPAs |
| Server state | TanStack Query v6 | Polling, optimistic updates, background refetch |
| Client state | Zustand 5 | 3KB, store-based, for UI state (sidebar, filters, selection) |
| Styling | Tailwind CSS v4 | CSS-first config, `@theme` tokens, Oxide engine |
| Components | shadcn/ui (Radix primitives) | Own the code, deepest accessibility, dark mode |
| Charts | Tremor + Recharts v3 | Tremor for dark mode out-of-box; Recharts for custom real-time |
| Workflow graph | React Flow v12 + Dagre | Industry standard for agent DAG/node visualization |
| Virtualization | TanStack Virtual | Log streams and long lists — only render visible rows |
| Real-time | SSE (EventSource) + polling | SSE for log streams; TanStack Query polling for status/metrics |
| Animation | motion/react | Spring physics, layout transitions, status pulse — GPU-accelerated 120fps |
| Typography | Geist Sans + Geist Mono | See `archon-visual-standards` |

Do not use: Next.js App Router (RSC model fights real-time client state), MUI (wrong aesthetic), Chakra UI (fights customization).

---

## Pattern 1: Status Badge

Use for: task status, run status, agent state, review gate state.

```tsx
const statusConfig = {
  running:        { label: 'Running',        color: 'text-cyan-400',  dot: 'bg-cyan-400 animate-pulse' },
  in_progress:    { label: 'In Progress',    color: 'text-cyan-400',  dot: 'bg-cyan-400 animate-pulse' },
  review_blocked: { label: 'Review Blocked', color: 'text-amber-400', dot: 'bg-amber-400' },
  ready:          { label: 'Ready',          color: 'text-indigo-400', dot: 'bg-indigo-400' },
  done:           { label: 'Done',           color: 'text-green-400', dot: 'bg-green-400' },
  blocked:        { label: 'Blocked',        color: 'text-red-400',   dot: 'bg-red-400' },
  approved:       { label: 'Approved',       color: 'text-green-400', dot: 'bg-green-400' },
}

function StatusBadge({ status }: { status: string }) {
  const cfg = statusConfig[status] ?? { label: status, color: 'text-neutral-400', dot: 'bg-neutral-400' }
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-xs">
      <span className={`h-1.5 w-1.5 rounded-full ${cfg.dot}`} />
      <span className={cfg.color}>{cfg.label}</span>
    </span>
  )
}
```

Rules: always use Geist Mono for status labels. Never use background-color pills for status — inline dot + label is the correct pattern for dense data UIs.

---

## Pattern 2: Authority Badge

Use for: distinguishing `runtime_authoritative` vs `derived_only` data (critical for Archon).

```tsx
function AuthorityBadge({ authority }: { authority: 'runtime_authoritative' | 'derived_only' }) {
  return authority === 'runtime_authoritative' ? (
    <span className="font-mono text-[10px] text-green-500 border border-green-500/20 px-1.5 py-0.5 rounded-sm">
      authoritative
    </span>
  ) : (
    <span className="font-mono text-[10px] text-neutral-500 border border-neutral-500/20 px-1.5 py-0.5 rounded-sm">
      derived
    </span>
  )
}
```

Show this badge on every piece of status data displayed — operators must know what to trust.

---

## Pattern 3: Data Table (dense, virtualized)

For task lists, run lists, review queues. Use TanStack Table + TanStack Virtual for >50 rows.

```tsx
// Column definition pattern
const columns: ColumnDef<TaskRecord>[] = [
  {
    accessorKey: 'id',
    header: 'Task',
    cell: ({ row }) => (
      <span className="font-mono text-xs text-neutral-400">{row.original.id.slice(0, 8)}</span>
    ),
    size: 80,
  },
  {
    accessorKey: 'packet.title',
    header: 'Title',
    cell: ({ row }) => (
      <span className="text-sm text-neutral-200 truncate">{row.original.packet.title}</span>
    ),
  },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
    size: 120,
  },
  {
    accessorKey: 'packet.ownerRole',
    header: 'Owner',
    cell: ({ row }) => (
      <span className="font-mono text-xs text-neutral-400">{row.original.packet.ownerRole}</span>
    ),
    size: 140,
  },
]
```

Table styling rules:
- `bg-surface-raised` for table background
- `border-b border-[rgba(255,255,255,0.08)]` between rows
- `hover:bg-surface-elevated` on row hover
- Sticky header with `bg-surface-base` to not lose context while scrolling
- Column headers: `text-[11px] font-mono uppercase tracking-widest text-neutral-500`

---

## Pattern 4: Streaming Log Panel

For: agent run logs, task execution output, live stdout streams via SSE.

Key implementation decisions:
- Auto-scroll to bottom when new lines arrive (unless user has scrolled up)
- TanStack Virtual for virtualized rendering — never render >1000 DOM nodes
- Geist Mono for all log text
- Line-level timestamp prefix in muted color
- SSE for log streaming (not WebSockets)

```tsx
function LogPanel({ runId }: { runId: string }) {
  const [lines, setLines] = useState<LogLine[]>([])
  const [userScrolled, setUserScrolled] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const sse = new EventSource(`/api/runs/${runId}/logs`)
    sse.onmessage = (e) => {
      const line: LogLine = JSON.parse(e.data)
      setLines(prev => [...prev, line])
    }
    return () => sse.close()
  }, [runId])

  useEffect(() => {
    if (!userScrolled) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lines, userScrolled])

  return (
    <div
      className="h-full overflow-y-auto bg-surface-base font-mono text-xs text-neutral-300 p-4 space-y-0.5"
      onScroll={(e) => {
        const el = e.currentTarget
        const atBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 20
        setUserScrolled(!atBottom)
      }}
    >
      {lines.map((line) => (
        <div key={line.id} className="flex gap-3">
          <span className="text-neutral-600 shrink-0 select-none">{line.timestamp}</span>
          <span className={line.level === 'error' ? 'text-red-400' : 'text-neutral-300'}>
            {line.content}
          </span>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  )
}
```

SSE endpoint pattern (Hono or Fastify):
```ts
app.get('/api/runs/:runId/logs', (c) => {
  return streamSSE(c, async (stream) => {
    // subscribe to postgres LISTEN/NOTIFY or log file tail
    for await (const line of subscribeToRunLogs(c.req.param('runId'))) {
      await stream.writeSSE({ data: JSON.stringify(line) })
    }
  })
})
```

---

## Pattern 5: Kanban Task Board

For: workflow task queue visualization by status column.

Layout: horizontal scroll of columns, each column is `w-72 shrink-0`, cards are draggable (use `@dnd-kit/core`).

```tsx
const COLUMNS: TaskStatus[] = ['ready', 'in_progress', 'review_blocked', 'approved', 'done']

function TaskBoard({ tasks }: { tasks: TaskRecord[] }) {
  const byStatus = groupBy(tasks, t => t.status)
  return (
    <div className="flex gap-3 overflow-x-auto pb-4 h-full">
      {COLUMNS.map(status => (
        <div key={status} className="w-72 shrink-0 flex flex-col gap-2">
          <div className="flex items-center justify-between px-2 py-1.5">
            <StatusBadge status={status} />
            <span className="font-mono text-xs text-neutral-600">{byStatus[status]?.length ?? 0}</span>
          </div>
          <div className="flex flex-col gap-2">
            {(byStatus[status] ?? []).map(task => (
              <TaskCard key={task.id} task={task} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function TaskCard({ task }: { task: TaskRecord }) {
  return (
    <div className="bg-surface-raised border border-[rgba(255,255,255,0.08)] rounded p-3 space-y-2 hover:border-[rgba(255,255,255,0.15)] transition-colors duration-150 cursor-pointer">
      <p className="text-sm text-neutral-200 leading-snug">{task.packet.title}</p>
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] text-neutral-500">{task.packet.ownerRole}</span>
        <span className="font-mono text-[10px] text-neutral-600">{task.id.slice(0, 8)}</span>
      </div>
      {task.packet.requiredReviews?.length > 0 && (
        <div className="flex gap-1">
          {task.packet.requiredReviews.map(r => (
            <span key={r} className="font-mono text-[9px] text-amber-500 border border-amber-500/20 px-1 py-0.5 rounded-sm">
              {r}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
```

---

## Pattern 6: Workflow DAG (React Flow)

For: task dependency graph, agent execution flow, review gate graph.

Setup:
```tsx
import ReactFlow, { Node, Edge, MarkerType } from 'reactflow'
import dagre from '@dagrejs/dagre'
import 'reactflow/dist/style.css'

// Auto-layout with Dagre
function layoutGraph(tasks: TaskRecord[]): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 80 })
  g.setDefaultEdgeLabel(() => ({}))

  tasks.forEach(t => g.setNode(t.id, { width: 200, height: 60 }))
  tasks.forEach(t => t.packet.dependencies.forEach(dep => g.setEdge(dep, t.id)))
  dagre.layout(g)

  const nodes: Node[] = tasks.map(t => {
    const pos = g.node(t.id)
    return {
      id: t.id,
      type: 'taskNode',
      position: { x: pos.x - 100, y: pos.y - 30 },
      data: { task: t },
    }
  })

  const edges: Edge[] = tasks.flatMap(t =>
    t.packet.dependencies.map(dep => ({
      id: `${dep}-${t.id}`,
      source: dep,
      target: t.id,
      markerEnd: { type: MarkerType.ArrowClosed, color: '#6B6B6B' },
      style: { stroke: '#6B6B6B', strokeWidth: 1 },
    }))
  )

  return { nodes, edges }
}
```

Node styling: dark surface card with status color left border strip. Do NOT use React Flow's default styling — override with Tailwind classes and custom node components.

---

## Pattern 7: Metric Cards (Tremor)

For: token usage, run counts, error rates, cost totals.

```tsx
import { AreaChart, Card, Metric, Text, BadgeDelta } from '@tremor/react'

function MetricPanel({ metrics }: { metrics: DashboardMetrics }) {
  return (
    <div className="grid grid-cols-4 gap-3">
      <Card className="bg-surface-raised border-[rgba(255,255,255,0.08)]">
        <Text className="text-neutral-500 text-xs font-mono uppercase tracking-widest">Total Runs</Text>
        <Metric className="text-neutral-200 font-mono">{metrics.totalRuns}</Metric>
        <BadgeDelta deltaType="increase">{metrics.runDelta}</BadgeDelta>
      </Card>
      {/* ... repeat for cost, token usage, error rate */}
    </div>
  )
}
```

Tremor dark mode: pass `className` overrides to match `--surface-raised` tokens. Configure Tremor's color palette to use the Archon indigo accent.

---

## Pattern 8: Trace Detail — Tree + Timeline Toggle

Langfuse's pattern: same execution data, two views toggled by user preference.

```tsx
type ViewMode = 'tree' | 'timeline'

function TraceDetail({ trace }: { trace: RunEvidenceReport }) {
  const [view, setView] = useState<ViewMode>('tree')
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between p-3 border-b border-[rgba(255,255,255,0.08)]">
        <h2 className="text-sm font-medium text-neutral-200">Trace</h2>
        <div className="flex gap-1 bg-surface-elevated rounded p-0.5">
          {(['tree', 'timeline'] as ViewMode[]).map(v => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-2.5 py-1 text-xs font-mono rounded transition-colors duration-150 ${
                view === v
                  ? 'bg-surface-overlay text-neutral-200'
                  : 'text-neutral-500 hover:text-neutral-300'
              }`}
            >
              {v}
            </button>
          ))}
        </div>
      </div>
      {view === 'tree' ? <TraceTree trace={trace} /> : <TraceTimeline trace={trace} />}
    </div>
  )
}
```

Tree view: nested indented list, each node shows role, status, duration.
Timeline view: custom D3-based Gantt — use `d3-scale` + SVG, not a charting library (none handle multi-row Gantt well).

---

## Pattern 9: Review Gate Queue

For: `reviewer`, `qa_engineer`, `security_reviewer` gate management.

```tsx
function ReviewGateQueue({ task }: { task: TaskRecord }) {
  const gates = task.packet.requiredReviews ?? []
  return (
    <div className="space-y-2">
      {gates.map(gate => {
        const review = task.reviews?.find(r => r.reviewerRole === gate)
        return (
          <div
            key={gate}
            className="flex items-center justify-between bg-surface-raised border border-[rgba(255,255,255,0.08)] rounded p-3"
          >
            <div className="flex items-center gap-3">
              <span className="font-mono text-xs text-neutral-400">{gate}</span>
              {review ? (
                <StatusBadge status={review.state} />
              ) : (
                <span className="font-mono text-xs text-neutral-600">awaiting</span>
              )}
            </div>
            {review?.findings?.length > 0 && (
              <span className="text-xs text-amber-400">{review.findings.length} finding(s)</span>
            )}
          </div>
        )
      })}
    </div>
  )
}
```

---

## Pattern 10: Blocker Banner

For: prominently surfacing blockers — the most important state in Archon.

```tsx
function BlockerBanner({ blockers }: { blockers: string[] }) {
  if (!blockers.length) return null
  return (
    <div className="border border-red-500/20 bg-red-500/5 rounded p-3 space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
        <span className="text-xs font-mono text-red-400 uppercase tracking-widest">Blocked</span>
      </div>
      <ul className="space-y-1 pl-3.5">
        {blockers.map((b, i) => (
          <li key={i} className="text-xs text-red-300">{b}</li>
        ))}
      </ul>
    </div>
  )
}
```

Blockers are always rendered first, before any other content, on any view that has blockers.

---

## Layout Architecture

```
┌─────────────────────────────────────────────────────┐
│  Sidebar (240px)    │  Main Content Area             │
│  ─────────────────  │  ──────────────────────────    │
│  Navigation         │  Route: /runs/:id              │
│  Active Run         │  ┌──────────────────────────┐  │
│  Quick Actions      │  │ Blockers (if any)        │  │
│  Agent Status       │  ├──────────────────────────┤  │
│                     │  │ Task Board / Kanban      │  │
│                     │  ├──────────────────────────┤  │
│                     │  │ Log Panel (SSE)          │  │
│                     │  └──────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

Sidebar: `bg-surface-raised`, `w-60 shrink-0`, `border-r border-[rgba(255,255,255,0.08)]`
Main: `bg-surface-base flex-1 overflow-hidden`
No top navigation bar — developer tools use sidebar-primary navigation.

---

## Real-Time Implementation

| Data | Transport | Interval |
|---|---|---|
| Agent run log stream | SSE (EventSource) | server-pushed |
| Task status updates | TanStack Query polling | 5s refetchInterval |
| Review gate state | TanStack Query polling | 10s |
| Dashboard metrics | TanStack Query polling | 30s |
| User actions (approve, dispatch) | REST POST | on-demand |

Use `EventSource` natively — no wrapper library needed. PostgreSQL `LISTEN/NOTIFY` → SSE is the cleanest bridge from Archon's runtime state.

Apply TanStack Virtual for log panels and any list that can exceed 100 items. Never render more than 100 DOM nodes for a log list.

---

## Pattern 11: Motion Patterns (motion/react)

Install: `npm install motion`

Use Motion for three recurring patterns in Archon UIs. Do not animate for decoration — every animation must communicate state change, reveal sequence, or spatial relationship.

### Status Pulse (running state indicator)

Replace Tailwind's `animate-pulse` with a Motion spring for a more credible "live" signal:

```tsx
import { motion } from 'motion/react'

function RunningDot() {
  return (
    <motion.span
      className="block h-1.5 w-1.5 rounded-full bg-cyan-400"
      animate={{ opacity: [1, 0.3, 1] }}
      transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
    />
  )
}
```

### Layout Transition (list additions and removals)

Use `AnimatePresence` + `layout` when tasks enter or leave a kanban column or review queue:

```tsx
import { AnimatePresence, motion } from 'motion/react'

function TaskList({ tasks }: { tasks: TaskRecord[] }) {
  return (
    <div className="flex flex-col gap-2">
      <AnimatePresence initial={false}>
        {tasks.map(task => (
          <motion.div
            key={task.id}
            layout
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
          >
            <TaskCard task={task} />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
```

### Stagger Reveal (initial page load or view switch)

When a panel first mounts and populates (e.g. trace detail, review gate queue), stagger children to avoid a wall of content appearing at once:

```tsx
import { motion } from 'motion/react'

const staggerContainer = {
  hidden: {},
  show: { transition: { staggerChildren: 0.04 } },
}

const staggerItem = {
  hidden: { opacity: 0, y: 6 },
  show:   { opacity: 1, y: 0, transition: { duration: 0.12, ease: 'easeOut' } },
}

function ReviewGateList({ gates }: { gates: ReviewGate[] }) {
  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="show" className="space-y-2">
      {gates.map(gate => (
        <motion.div key={gate.role} variants={staggerItem}>
          <ReviewGateRow gate={gate} />
        </motion.div>
      ))}
    </motion.div>
  )
}
```

Rules:
- Duration 100–200ms for UI feedback; 150–250ms for reveals. Never exceed 300ms on state-driven transitions.
- Always add `prefers-reduced-motion` support: wrap animation values with `useReducedMotion()` and fall back to instant transitions.
- Do not animate data cells, table rows in steady state, or background surfaces. Animate only items whose presence, absence, or state change is meaningful.

---

## Output

When applying this skill, return:
- Patterns chosen and why
- Stack decisions confirmed or deviated from (with reason)
- Real-time transport choice
- Accessibility notes for interactive components
