/**
 * GateSwimlane — the three-column swimlane grid.
 *
 * Primary IA axis: review gate ROLE (horizontal). One column per required gate role.
 * Each column header shows: [alert dot if bottleneck] | role name (mono) | task count.
 *
 * Swimlane assignment logic:
 *   - A task appears in the column of its MOST URGENT gate for that role.
 *   - "blocked" gate is most urgent, then "pending", then "passed", then "waived".
 *   - A task with gates in multiple roles appears in each relevant column.
 *   - Bottleneck column = has at least one "blocked" gate.
 *
 * Tasks within a column are sorted: blocked first, pending, passed, waived.
 */

import type {
  GateReviewRole,
  ReviewGateViewModel,
  ReviewState,
  TaskQueueEntryViewModel,
} from "../types/dashboard.ts";
import { TaskCard } from "./TaskCard.tsx";

interface GateSwimlaneProps {
  taskQueue: TaskQueueEntryViewModel[];
  reviewGates: ReviewGateViewModel[];
}

const GATE_ROLES: GateReviewRole[] = [
  "reviewer",
  "security_reviewer",
  "qa_engineer",
];

const STATE_PRIORITY: Record<ReviewState, number> = {
  blocked: 0,
  pending: 1,
  passed: 2,
  waived: 3,
};

const ROLE_LABEL: Record<GateReviewRole, string> = {
  reviewer: "reviewer",
  security_reviewer: "security_reviewer",
  qa_engineer: "qa_engineer",
};

interface LaneCard {
  task: TaskQueueEntryViewModel;
  gate: ReviewGateViewModel;
}

function buildLaneCards(
  role: GateReviewRole,
  taskQueue: TaskQueueEntryViewModel[],
  reviewGates: ReviewGateViewModel[]
): LaneCard[] {
  // Collect all gates for this role
  const gatesForRole = reviewGates.filter((g) => g.role === role);

  // Build map: taskId → gate (most urgent)
  const taskGateMap = new Map<string, ReviewGateViewModel>();
  for (const gate of gatesForRole) {
    const existing = taskGateMap.get(gate.taskId);
    if (!existing || STATE_PRIORITY[gate.state] < STATE_PRIORITY[existing.state]) {
      taskGateMap.set(gate.taskId, gate);
    }
  }

  // Match tasks to their gates
  const cards: LaneCard[] = [];
  for (const task of taskQueue) {
    const gate = taskGateMap.get(task.taskId);
    if (gate) {
      cards.push({ task, gate });
    }
  }

  // Sort within lane: blocked first, pending, passed, waived
  cards.sort((a, b) => STATE_PRIORITY[a.gate.state] - STATE_PRIORITY[b.gate.state]);

  return cards;
}

function isBottleneckLane(cards: LaneCard[]): boolean {
  return cards.some((c) => c.gate.state === "blocked");
}

interface SwimlaneColumnProps {
  role: GateReviewRole;
  cards: LaneCard[];
  isBottleneck: boolean;
}

function SwimlaneColumn({ role, cards, isBottleneck }: SwimlaneColumnProps) {
  const label = ROLE_LABEL[role];

  return (
    <div className="swimlane-col" aria-label={`${label} lane`}>
      <div className="swimlane-col__header">
        {isBottleneck && (
          <span
            className="swimlane-col__alert"
            style={{ backgroundColor: "var(--status-error)" }}
            aria-label="Bottleneck lane"
            role="img"
          />
        )}
        <span className="swimlane-col__title mono">{label}</span>
        <span className="swimlane-col__count mono" aria-label={`${cards.length} tasks`}>
          {cards.length} {cards.length === 1 ? "task" : "tasks"}
        </span>
      </div>

      <div className="swimlane-col__cards">
        {cards.length === 0 ? (
          <div className="lane-empty" aria-label="No tasks in this lane">
            <span className="lane-empty__label mono">no tasks</span>
          </div>
        ) : (
          cards.map(({ task, gate }) => (
            <TaskCard key={`${task.taskId}-${role}`} task={task} gate={gate} />
          ))
        )}
      </div>
    </div>
  );
}

export function GateSwimlane({ taskQueue, reviewGates }: GateSwimlaneProps) {
  const columns = GATE_ROLES.map((role) => {
    const cards = buildLaneCards(role, taskQueue, reviewGates);
    return { role, cards, isBottleneck: isBottleneckLane(cards) };
  });

  return (
    <section className="swimlane-area" aria-label="Review gate swimlanes">
      <div
        className="swimlane-grid"
        role="list"
        aria-label="Swimlane columns"
        /*
         * tabIndex="0" makes this scrollable region keyboard-accessible
         * (WCAG 2.1 SC 2.1.1, axe rule: scrollable-region-focusable).
         * At narrow viewports the 3-column grid overflows and requires scrolling.
         */
        tabIndex={0}
      >
        {columns.map(({ role, cards, isBottleneck }) => (
          <div key={role} role="listitem">
            <SwimlaneColumn role={role} cards={cards} isBottleneck={isBottleneck} />
          </div>
        ))}
      </div>
    </section>
  );
}
