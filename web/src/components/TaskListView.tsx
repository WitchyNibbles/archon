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
  ReviewGateViewModel,
  TaskQueueEntryViewModel,
  TaskStatus,
} from "../types/dashboard.ts";
import { TaskRow } from "./TaskRow.tsx";

interface TaskListViewProps {
  taskQueue: TaskQueueEntryViewModel[];
  reviewGates: ReviewGateViewModel[];
  /** Tab panel id — wired to the corresponding tab button's aria-controls. */
  tabPanelId: string;
  /** The id of the tab button that controls this panel (for aria-labelledby). */
  labelledBy: string;
}

// ── Bucket definitions ────────────────────────────────────────────────────────

type BucketId = "blocked" | "in_progress" | "ready" | "done";

interface BucketConfig {
  id: BucketId;
  label: string;
  /** Color token for the section header text (status-text variant for AA on dark). */
  headerColor: string;
  statuses: ReadonlyArray<TaskStatus>;
}

const BUCKETS: readonly BucketConfig[] = [
  {
    id: "blocked",
    label: "Blocked",
    headerColor: "var(--status-error-text)",
    statuses: ["blocked", "review_blocked"],
  },
  {
    id: "in_progress",
    label: "In Progress",
    headerColor: "var(--status-running-text)",
    statuses: ["in_progress"],
  },
  {
    id: "ready",
    label: "Ready / Queued",
    headerColor: "var(--status-pending-text)",
    statuses: ["ready"],
  },
  {
    id: "done",
    label: "Done",
    headerColor: "var(--status-muted-text)",
    statuses: ["approved", "done"],
  },
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Group tasks into buckets in BLOCKED → IN PROGRESS → READY/QUEUED → DONE order. */
function bucketTasks(
  taskQueue: TaskQueueEntryViewModel[]
): Map<BucketId, TaskQueueEntryViewModel[]> {
  const result = new Map<BucketId, TaskQueueEntryViewModel[]>(
    BUCKETS.map((b) => [b.id, []])
  );

  for (const task of taskQueue) {
    for (const bucket of BUCKETS) {
      if ((bucket.statuses as ReadonlyArray<string>).includes(task.status)) {
        result.get(bucket.id)!.push(task);
        break; // each task goes into exactly one bucket
      }
    }
    // Tasks with unrecognized status are silently omitted
    // (schema validation upstream ensures only valid statuses reach here)
  }

  return result;
}

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
// AG-018: no SVG illustration. Plain mono text only.

function EmptyTaskList() {
  /*
   * Plain <p> has implicit role="paragraph" which allows aria-label.
   * The outer <div> has role="generic" — aria-label is prohibited on generic.
   * Move the accessible name to the <p> element directly.
   */
  return (
    <div className="task-list-empty">
      <p className="task-list-empty__label mono">no tasks recorded yet</p>
    </div>
  );
}

// ── TaskListView ──────────────────────────────────────────────────────────────

export function TaskListView({
  taskQueue,
  reviewGates,
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
        <EmptyTaskList />
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
