/**
 * TaskListView — full task queue as a flat status-grouped list (dashQuality S1).
 *
 * Renders ALL tasks from data.taskQueue (the void fix: no task is dropped).
 *
 * Bucket order: BLOCKED → IN PROGRESS → READY/QUEUED → DONE
 *
 * Each bucket:
 *   - Compact sticky section header: 28px, 9px uppercase Geist Mono,
 *     matching status-text token, --surface-elevated background
 *   - Flat TaskRow items (~36px / 48px max) — never TaskCard
 *
 * Gate mini-pills: built by looking up each task's gates in reviewGates
 * (passed-through from the view model). One pill per gate entry for the task.
 *
 * Empty state: "no tasks recorded yet" in Geist Mono --text-secondary, 12px,
 * centered. NO SVG illustration (AG-018 forbids icon-above-text empty states).
 *
 * A11y:
 *   - id={tabpanelId} + role="tabpanel" + aria-labelledby → wired to TabBar
 *   - role="list" wraps TaskRow elements (role="listitem") per bucket
 *     (role="rowgroup" requires a table context — axe aria-required-parent violation)
 *   - Keyboard reachable via Tab → individual task rows have tabIndex=0
 *
 * R2-C boundary: no import from src/. All types come from web/src/types/.
 */

import type {
  BlockerViewModel,
  ReviewGateViewModel,
  TaskQueueEntryViewModel,
} from "../types/dashboard.ts";
import { TaskRow } from "./TaskRow.tsx";
import { BUCKETS, bucketTasks, type BucketId } from "../utils/taskBuckets.ts";
import { blockersForTask } from "../utils/taskDetail.ts";
// Council forgeEmptyStateIllustration: the one approved on-brand empty-state asset
// (Codex-generated, QA-passed). Vite resolves this PNG import to a hashed URL.
import emptyStateIllustration from "../assets/dashboard-empty-state.png";

interface TaskListViewProps {
  taskQueue: TaskQueueEntryViewModel[] | readonly TaskQueueEntryViewModel[];
  reviewGates: ReviewGateViewModel[];
  /** Run-level blockers, used for per-task drill-down detail (S3a). */
  blockers: BlockerViewModel[];
  /** Whether the in-run Blocked filter is active — drives the empty-state copy (S3a). */
  filterActive: boolean;
  /** Tab panel id — wired to the corresponding tab button's aria-controls. */
  tabPanelId: string;
  /** The id of the tab button that controls this panel (for aria-labelledby). */
  labelledBy: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
// BUCKETS + bucketTasks are extracted to ../utils/taskBuckets.ts (pure, unit-tested).

/** Look up all review gates for a given taskId. */
function gatesForTask(
  taskId: string,
  reviewGates: ReviewGateViewModel[]
): ReviewGateViewModel[] {
  return reviewGates.filter((g) => g.taskId === taskId);
}

// ── Section header ────────────────────────────────────────────────────────────

interface BucketHeaderProps {
  label: string;
  count: number;
  headerColor: string;
  bucketId: BucketId;
}

function BucketHeader({ label, count, headerColor, bucketId }: BucketHeaderProps) {
  return (
    /*
     * role="presentation" because the bucket heading is purely visual decoration.
     * The section below uses role="group" + aria-labelledby pointing to the span
     * with the bucket label — the visible text already provides the accessible name
     * without needing aria-label on this wrapper div.
     *
     * ARIA 1.2: aria-label is prohibited on role="generic" (plain div).
     * Do NOT add aria-label here.
     */
    <div className="task-list-section__header" role="presentation">
      <span
        className="task-list-section__label mono"
        style={{ color: headerColor }}
        id={`bucket-header-${bucketId}`}
      >
        {label}
      </span>
      <span className="task-list-section__count mono" aria-label={`${count} ${count === 1 ? "task" : "tasks"}`}>
        {count}
      </span>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────
//
// AG-018 normally forbids an illustration-above-label empty state (text-only).
// Council `forgeEmptyStateIllustration` (approved_with_conditions) permits ONE
// on-brand minimal illustration here, exempted via the explicit `data-ag018-allow`
// marker bound to the QA-passed manifest asset `dashboard-empty-state`. The marker
// is a SINGLETON (any further empty-state illustration needs a new council packet).
// The illustration is DECORATIVE (alt="" + aria-hidden); the mono text label stays
// as the sole accessible name. It appears only on the primary "no tasks" state —
// the filtered "no blocked tasks" view stays text-only (and unmarked).

function EmptyTaskList({ filterActive }: { filterActive: boolean }) {
  /*
   * Plain <p> has implicit role="paragraph" which allows aria-label.
   * S3a: the copy is honest about WHY the list is empty — an active Blocked filter
   * with nothing blocked is good news ("no blocked tasks"), not "no tasks recorded".
   *
   * Structure (primary state): the container has exactly [img, p] — the AG-018
   * pattern is genuinely present, and the container carries data-ag018-allow so the
   * checker exempts THIS specific QA-passed asset rather than the pattern being hidden.
   */
  const label = filterActive ? "no blocked tasks" : "no tasks recorded yet";
  return (
    <div
      className="task-list-empty"
      data-ag018-allow={filterActive ? undefined : "dashboard-empty-state"}
    >
      {!filterActive && (
        <img
          className="task-list-empty__art"
          src={emptyStateIllustration}
          alt=""
          aria-hidden="true"
          draggable={false}
        />
      )}
      <p className="task-list-empty__label mono">{label}</p>
    </div>
  );
}

// ── TaskListView ──────────────────────────────────────────────────────────────

export function TaskListView({
  taskQueue,
  reviewGates,
  blockers,
  filterActive,
  tabPanelId,
  labelledBy,
}: TaskListViewProps) {
  const buckets = bucketTasks(taskQueue);

  // Determine which buckets have tasks (omit empty buckets from render)
  const nonEmptyBuckets = BUCKETS.filter(
    (b) => (buckets.get(b.id)?.length ?? 0) > 0
  );

  const hasAnyTask = nonEmptyBuckets.length > 0;

  return (
    /*
     * role="tabpanel" supports aria-labelledby (tab button → panel label).
     * aria-label is omitted here — when both aria-label and aria-labelledby are
     * present on the same element, aria-labelledby wins and aria-label is ignored
     * (ARIA 1.2 §6.1). Drop aria-label to keep the accessible name unambiguous.
     */
    <section
      id={tabPanelId}
      role="tabpanel"
      aria-labelledby={labelledBy}
      className="task-list-view"
    >
      {!hasAnyTask ? (
        <EmptyTaskList filterActive={filterActive} />
      ) : (
        nonEmptyBuckets.map((bucket) => {
          const tasks = buckets.get(bucket.id) ?? [];
          const headerId = `bucket-header-${bucket.id}`;
          return (
            /*
             * role="group" allows aria-labelledby to reference the bucket header span.
             * Plain <div> (role="generic") prohibits aria-label — axe aria-prohibited-attr.
             * aria-labelledby → the <span id={headerId}> inside BucketHeader.
             */
            <div
              key={bucket.id}
              className="task-list-section"
              data-bucket={bucket.id}
              role="group"
              aria-labelledby={headerId}
            >
              <BucketHeader
                label={bucket.label}
                count={tasks.length}
                headerColor={bucket.headerColor}
                bucketId={bucket.id}
              />
              {/*
               * role="list" + no aria-label on a plain div avoids aria-prohibited-attr.
               * The group aria-labelledby above already names this bucket's region.
               */}
              <div role="list">
                {tasks.map((task) => (
                  <TaskRow
                    key={task.taskId}
                    task={task}
                    gates={gatesForTask(task.taskId, reviewGates)}
                    blockers={blockersForTask(task.taskId, blockers)}
                  />
                ))}
              </div>
            </div>
          );
        })
      )}
    </section>
  );
}
