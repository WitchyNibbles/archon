import type { ExportDocsRequest, ExportDocsSummary, WorklogEntry } from "./models.ts";

function formatDecisionMemoryEntry(input: { title: string; content: string }): string {
  const content = input.content.trim();
  if (content.length > 0) {
    return content;
  }
  return input.title.trim();
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function titleCaseSlug(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function buildDateLabel(request: ExportDocsRequest): string {
  if (request.dateFrom && request.dateTo && request.dateFrom === request.dateTo) {
    return request.dateFrom;
  }
  if (request.dateFrom && request.dateTo) {
    return `${request.dateFrom} to ${request.dateTo}`;
  }
  if (request.dateFrom) {
    return `from ${request.dateFrom}`;
  }
  if (request.dateTo) {
    return `through ${request.dateTo}`;
  }
  return "all recorded work";
}

function buildTitle(request: ExportDocsRequest): string {
  const projectLabel = titleCaseSlug(request.project ?? "archon");
  const dateLabel = buildDateLabel(request);
  if (request.format === "feature_doc") {
    return request.rawQuery
      .replace(/^create\s+documentation\s+for\s+/i, "")
      .replace(/^document\s+/i, "")
      .trim()
      .replace(/\.$/, "");
  }
  if (request.format === "project_summary") {
    return `${projectLabel} project summary - ${dateLabel}`;
  }
  if (request.format === "decision_log") {
    return `${projectLabel} decision log`;
  }
  return `${projectLabel} work summary - ${dateLabel}`;
}

export class DocsSummarizer {
  summarize(entries: readonly WorklogEntry[], request: ExportDocsRequest): ExportDocsSummary {
    const runCount = entries.length;
    const taskRecords = entries.flatMap((entry) => entry.tasks);
    const handoffs = entries.flatMap((entry) => Object.values(entry.handoffsByTask).flat());
    const reviews = entries.flatMap((entry) => Object.values(entry.reviewsByTask).flat());
    const approvals = entries.flatMap((entry) => Object.values(entry.approvalsByTask).flat());
    const planDecisions = entries.flatMap((entry) => entry.plan?.content.decisions ?? []);
    const memoryDecisions = entries.flatMap((entry) =>
      entry.decisionMemoryEntries.map((memoryEntry) =>
        formatDecisionMemoryEntry({
          title: memoryEntry.title,
          content: memoryEntry.content
        })
      )
    );
    const planMilestones = entries.flatMap((entry) => entry.plan?.content.milestones ?? []);
    const handoffFiles = handoffs.flatMap((handoff) => handoff.changedFiles);
    const blockedFindings = reviews.flatMap((review) => review.findings);
    const blockers = handoffs.flatMap((handoff) => handoff.blockers);
    const nextSteps = dedupe([
      ...taskRecords
        .filter((task) => task.status !== "approved" && task.status !== "done")
        .map((task) => `${task.packet.title} (${task.status})`),
      ...entries.flatMap((entry) => entry.plan?.content.residualRisks ?? []),
      ...blockers
    ]);

    const topics = dedupe([
      ...entries.map((entry) => entry.run.title),
      ...planMilestones,
      ...taskRecords.map((task) => task.packet.title)
    ]);

    const decisions = dedupe([
      ...planDecisions,
      ...memoryDecisions,
      ...approvals
        .filter(
          (approval) =>
            approval.decision === "approved" &&
            approval.rationale.trim().length > 0 &&
            approval.rationale !== "All required reviews passed" &&
            !approval.rationale.startsWith("missing required review:") &&
            !approval.rationale.startsWith("required review")
        )
        .map((approval) => approval.rationale)
    ]);

    const tasks = dedupe(taskRecords.map((task) => `${task.packet.title} (${task.status})`));
    const files = dedupe(handoffFiles);
    const bugs = dedupe([...blockedFindings, ...blockers]);
    const summaryLine = [
      `${runCount} run${runCount === 1 ? "" : "s"} matched ${buildDateLabel(request)}.`,
      `${taskRecords.length} task${taskRecords.length === 1 ? "" : "s"}, ${handoffs.length} handoff${handoffs.length === 1 ? "" : "s"}, ${reviews.length} review${reviews.length === 1 ? "" : "s"}, and ${approvals.length} approval${approvals.length === 1 ? "" : "s"} were included.`
    ].join(" ");

    return {
      title: buildTitle(request),
      summary: summaryLine,
      topics,
      decisions,
      tasks,
      bugs,
      files,
      nextSteps,
      relatedNotes: [`[[${titleCaseSlug(request.project ?? "archon")}]]`]
    };
  }
}
