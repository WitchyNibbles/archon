/**
 * Archon workflow artifact contract check.
 *
 * TypeScript replacement for the former scripts/check-archon-workflow.sh.
 * Behavior, messages, and exit codes are preserved:
 *   - exit 0: artifact contract satisfied
 *   - exit 1: contract violation ("archon workflow check failed: ...")
 *   - exit 2: usage error
 *
 * Run with: node --experimental-strip-types scripts/check-archon-workflow.ts [options]
 * Options: [--repo-root <path>] [--task-id <task-id>] [--live] [--external-review-authority]
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

let repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let requestedTaskId = "";
let liveMode = false;
let externalReviewAuthority = false;

const args = process.argv.slice(2);
let argIndex = 0;
while (argIndex < args.length) {
  const arg = args[argIndex] as string;
  if (arg === "--repo-root") {
    if (argIndex + 1 >= args.length) {
      process.stderr.write(`missing value for ${arg}\n`);
      process.exit(2);
    }
    repoRoot = args[argIndex + 1] as string;
    argIndex += 2;
  } else if (arg === "--task-id") {
    if (argIndex + 1 >= args.length) {
      process.stderr.write(`missing value for ${arg}\n`);
      process.exit(2);
    }
    requestedTaskId = args[argIndex + 1] as string;
    argIndex += 2;
  } else if (arg === "--live") {
    liveMode = true;
    argIndex += 1;
  } else if (arg === "--external-review-authority") {
    externalReviewAuthority = true;
    argIndex += 1;
  } else if (arg.startsWith("-")) {
    process.stderr.write(`unknown option: ${arg}\n`);
    process.exit(2);
  } else {
    repoRoot = arg;
    argIndex += 1;
  }
}

function fail(message: string): never {
  process.stderr.write(`archon workflow check failed: ${message}\n`);
  process.exit(1);
}

function failRaw(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function rel(filePath: string): string {
  const prefix = `${repoRoot}/`;
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
}

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function validateTaskId(value: string): void {
  if (!TASK_ID_PATTERN.test(value)) {
    fail(`task_id must match ^[A-Za-z0-9][A-Za-z0-9._-]*$: ${value}`);
  }
}

if (requestedTaskId !== "") {
  validateTaskId(requestedTaskId);
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function requireFile(filePath: string): void {
  if (!isFile(filePath)) {
    fail(`missing file: ${rel(filePath)}`);
  }
}

function readFileOrFail(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    fail(`missing file: ${rel(filePath)}`);
  }
}

function fileLines(filePath: string): string[] {
  const lines = readFileOrFail(filePath).split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function requireGrep(pattern: string, filePath: string): void {
  if (!readFileOrFail(filePath).includes(pattern)) {
    fail(`missing required text in ${rel(filePath)}: ${pattern}`);
  }
}

function requireHeading(heading: string, filePath: string): void {
  if (!readFileOrFail(filePath).includes(heading)) {
    fail(`missing heading ${heading} in ${rel(filePath)}`);
  }
}

function extractSectionValue(heading: string, filePath: string): string {
  let inSection = false;
  for (const line of fileLines(filePath)) {
    if (line === heading) {
      inSection = true;
      continue;
    }
    if (inSection && line.startsWith("## ")) {
      break;
    }
    if (inSection && line.trim() !== "") {
      return line.replace(/\r/g, "");
    }
  }
  return "";
}

function extractSectionBlock(heading: string, filePath: string): string {
  const collected: string[] = [];
  let inSection = false;
  for (const line of fileLines(filePath)) {
    if (line === heading) {
      inSection = true;
      continue;
    }
    if (inSection && line.startsWith("## ")) {
      break;
    }
    if (inSection) {
      collected.push(line.replace(/\r/g, ""));
    }
  }
  return collected.join("\n").replace(/\n+$/, "");
}

function normalizeValue(value: string): string {
  const stripped = value.replace(/\r/g, "").replace(/`/g, "");
  return stripped
    .split("\n")
    .map((line) => line.replace(/^\s+/, "").replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

function extractListItems(heading: string, filePath: string): string[] {
  const block = extractSectionBlock(heading, filePath);
  if (block === "") {
    return [];
  }
  const items: string[] = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine
      .replace(/\r/g, "")
      .replace(/`/g, "")
      .replace(/^[\s-]+/, "")
      .replace(/\s+$/, "");
    if (line !== "" && !line.startsWith("### ")) {
      items.push(line);
    }
  }
  return items;
}

function extractSectionKeyValue(heading: string, key: string, filePath: string): string {
  const block = extractSectionBlock(heading, filePath);
  for (const rawLine of block.split("\n")) {
    const line = rawLine.replace(/\r/g, "");
    if (line === "" || /^\s*#/.test(line)) {
      continue;
    }
    const separator = line.indexOf("=");
    const currentKey = (separator === -1 ? line : line.slice(0, separator)).trim();
    if (currentKey === key) {
      const value = separator === -1 ? line : line.slice(separator + 1);
      return value.trim();
    }
  }
  return "";
}

function extractMarkedBlock(startMarker: string, endMarker: string, filePath: string): string[] {
  const collected: string[] = [];
  let inBlock = false;
  for (const line of fileLines(filePath)) {
    if (line.includes(startMarker)) {
      inBlock = true;
      continue;
    }
    if (line.includes(endMarker)) {
      break;
    }
    if (inBlock) {
      collected.push(line);
    }
  }
  return collected;
}

function extractContractValue(key: string, filePath: string): string {
  const blockLines = extractMarkedBlock(
    "<!-- archon-workflow-contract:start -->",
    "<!-- archon-workflow-contract:end -->",
    filePath
  );
  for (const rawLine of blockLines) {
    const line = rawLine.replace(/\r/g, "").trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const separatorRaw = rawLine.indexOf("=");
    const currentKey = (separatorRaw === -1 ? rawLine : rawLine.slice(0, separatorRaw)).trim();
    if (currentKey !== key) {
      continue;
    }
    const separator = line.indexOf("=");
    return separator === -1 ? line : line.slice(separator + 1);
  }
  return "";
}

function requireSectionEquals(heading: string, expected: string, filePath: string): void {
  const raw = extractSectionValue(heading, filePath);
  if (raw === "") {
    fail(`missing section value ${heading} in ${rel(filePath)}`);
  }
  if (normalizeValue(raw) !== expected) {
    fail(`unexpected value for ${heading} in ${rel(filePath)}: expected ${expected}`);
  }
}

function requireContractEquals(key: string, expected: string, filePath: string): void {
  const raw = extractContractValue(key, filePath);
  if (raw === "") {
    fail(`missing workflow contract key ${key} in ${rel(filePath)}`);
  }
  if (normalizeValue(raw) !== expected) {
    fail(`unexpected workflow contract value for ${key} in ${rel(filePath)}: expected ${expected}`);
  }
}

function requireAllowedValue(value: string, filePath: string, ...allowed: string[]): void {
  for (const candidate of allowed) {
    if (value === candidate) {
      return;
    }
  }
  fail(`unexpected value in ${rel(filePath)}: ${value}`);
}

function requireNonemptySectionBlock(heading: string, filePath: string): void {
  const block = extractSectionBlock(heading, filePath);
  if (normalizeValue(block).trim() === "") {
    fail(`missing section content ${heading} in ${rel(filePath)}`);
  }
}

function requireRuntimeProofReference(block: string, filePath: string, heading: string): void {
  const cited = block.split("\n").some((line) => /^[\s-]*Runtime proof:\s*[^\s<].*$/.test(line));
  if (!cited) {
    fail(
      `specialist_verified runtime_verified summaries must cite Runtime proof in ${heading} of ${rel(filePath)}`
    );
  }
}

function loadSupportedQualityGates(): string[] {
  const rulesPath = path.join(repoRoot, ".archon/rules/task-quality-matrix.md");
  if (!isFile(rulesPath)) {
    fail(`missing quality gate rules: ${rel(rulesPath)}`);
  }
  const gates: string[] = [];
  for (const line of fileLines(rulesPath)) {
    if (line.startsWith("### `")) {
      gates.push(line.replace(/^### `/, "").replace(/`$/, ""));
    }
  }
  return gates;
}

function readJsonOrFail(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    failRaw(
      `archon workflow check failed: unreadable JSON artifact ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const coverageThresholdKeys = [
  "critical_item_coverage",
  "critical_item_validation",
  "callsite_coverage",
  "runtime_trace_coverage"
];

function validateCoverageManifestArtifact(artifactPath: string): void {
  const artifact = asRecord(readJsonOrFail(artifactPath));
  const errors: string[] = [];

  const requiredCategories = artifact.required_categories;
  if (!Array.isArray(requiredCategories) || requiredCategories.length === 0) {
    errors.push("required_categories must contain at least one category");
  }

  const thresholds = asRecord(artifact.thresholds);
  for (const key of coverageThresholdKeys) {
    const value = thresholds[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      errors.push(`thresholds.${key} must be a finite number between 0 and 1`);
    }
  }

  if (errors.length > 0) {
    failRaw(
      `archon workflow check failed: invalid coverage manifest artifact ${artifactPath}: ${errors.join("; ")}`
    );
  }
}

function validateCoverageLedgerArtifacts(
  manifestPath: string,
  itemsPath: string,
  gapsPath: string,
  dependencyGraphPath: string,
  tracesPath: string
): void {
  const manifest = asRecord(readJsonOrFail(manifestPath));
  const items = readJsonOrFail(itemsPath);
  const gaps = readJsonOrFail(gapsPath);
  const dependencyGraph = readJsonOrFail(dependencyGraphPath);
  const traces = readJsonOrFail(tracesPath);
  const errors: string[] = [];

  const requiredCategories = manifest.required_categories;
  if (!Array.isArray(requiredCategories) || requiredCategories.length === 0) {
    errors.push("required_categories must contain at least one category");
  }

  const thresholds = asRecord(manifest.thresholds);
  for (const key of coverageThresholdKeys) {
    const value = thresholds[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      errors.push(`thresholds.${key} must be a finite number between 0 and 1`);
    }
  }

  if (!Array.isArray(items)) {
    errors.push("coverage items artifact must be an array");
  }

  if (!Array.isArray(gaps)) {
    errors.push("coverage gaps artifact must be an array");
  }

  if (!Array.isArray(traces)) {
    errors.push("coverage traces artifact must be an array");
  }

  if (!dependencyGraph || typeof dependencyGraph !== "object") {
    errors.push("coverage dependency graph artifact must be an object");
  }

  if (Array.isArray(items)) {
    const itemIds = new Set<unknown>();
    const presentCategories = new Set<unknown>();
    for (const itemValue of items) {
      const item = asRecord(itemValue);
      if (itemIds.has(item.id)) {
        errors.push(`duplicate coverage item id ${String(item.id)}`);
      }
      itemIds.add(item.id);
      presentCategories.add(item.category);

      if (!Array.isArray(item.sources) || item.sources.length === 0) {
        errors.push(`coverage item ${String(item.id)} must include at least one source`);
      }
      if (!Array.isArray(item.evidence_refs) || item.evidence_refs.length === 0) {
        errors.push(`coverage item ${String(item.id)} must include at least one evidenceRef`);
      }
      const callsiteCount = item.callsite_count;
      const callsitesAnalyzed = item.callsites_analyzed;
      if (
        typeof callsiteCount === "number" &&
        Number.isFinite(callsiteCount) &&
        typeof callsitesAnalyzed === "number" &&
        Number.isFinite(callsitesAnalyzed) &&
        callsitesAnalyzed > callsiteCount
      ) {
        errors.push(`coverage item ${String(item.id)} callsitesAnalyzed cannot exceed callsiteCount`);
      }
      if (
        item.state === "validated" &&
        (!Array.isArray(item.verification_refs) || item.verification_refs.length === 0)
      ) {
        errors.push(`validated coverage item ${String(item.id)} must include verificationRefs`);
      }
    }

    const categories = Array.isArray(requiredCategories) ? requiredCategories : [];
    for (const category of categories) {
      if (!presentCategories.has(category)) {
        errors.push(`coverage items artifact is missing required category ${String(category)}`);
      }
    }

    if (dependencyGraph && typeof dependencyGraph === "object") {
      const graph = asRecord(dependencyGraph);
      const generatedAt = graph.generated_at;
      if (typeof generatedAt !== "string" || generatedAt.trim().length === 0) {
        errors.push("coverage dependency graph artifact must include generated_at");
      }
      if (!Array.isArray(graph.nodes)) {
        errors.push("coverage dependency graph artifact must include nodes");
      }
      if (!Array.isArray(graph.edges)) {
        errors.push("coverage dependency graph artifact must include edges");
      }

      if (Array.isArray(graph.nodes) && Array.isArray(graph.edges)) {
        const nodeIds = new Set<string>();
        for (const nodeValue of graph.nodes) {
          const node = asRecord(nodeValue);
          if (typeof node.id !== "string" || node.id.trim().length === 0) {
            errors.push("coverage dependency graph node must include id");
            continue;
          }
          if (nodeIds.has(node.id)) {
            errors.push(`duplicate coverage dependency graph node ${node.id}`);
            continue;
          }
          nodeIds.add(node.id);
        }

        for (const itemValue of items) {
          const item = asRecord(itemValue);
          if (typeof item.id !== "string" || !nodeIds.has(item.id)) {
            errors.push(`coverage dependency graph is missing node for coverage item ${String(item.id)}`);
          }
        }

        for (const edgeValue of graph.edges) {
          const edge = asRecord(edgeValue);
          if (typeof edge.from !== "string" || edge.from.trim().length === 0) {
            errors.push("coverage dependency graph edge must include from");
            continue;
          }
          if (typeof edge.to !== "string" || edge.to.trim().length === 0) {
            errors.push("coverage dependency graph edge must include to");
            continue;
          }
          if (edge.kind !== "depends_on") {
            errors.push(
              `coverage dependency graph edge ${edge.from}->${edge.to} has unsupported kind ${String(edge.kind)}`
            );
          }
          if (!nodeIds.has(edge.from)) {
            errors.push(`coverage dependency graph edge references unknown from node ${edge.from}`);
          }
          if (!nodeIds.has(edge.to)) {
            errors.push(`coverage dependency graph edge references unknown to node ${edge.to}`);
          }
        }
      }
    }
  }

  if (Array.isArray(gaps)) {
    for (const gapValue of gaps) {
      const gap = asRecord(gapValue);
      if (typeof gap.target_id !== "string" || gap.target_id.trim().length === 0) {
        errors.push(`gap ${String(gap.id)} must include a targetId`);
      }
      if (!Array.isArray(gap.evidence_refs) || gap.evidence_refs.length === 0) {
        errors.push(`gap ${String(gap.id)} must include evidenceRefs`);
      }
      if (typeof gap.created_by !== "string" || gap.created_by.trim().length === 0) {
        errors.push(`gap ${String(gap.id)} must include createdBy`);
      }
      if (
        gap.status === "open" &&
        (!Array.isArray(gap.suggested_next_actions) || gap.suggested_next_actions.length === 0)
      ) {
        errors.push(`open gap ${String(gap.id)} must include suggestedNextActions`);
      }
    }
  }

  if (Array.isArray(traces)) {
    for (const traceValue of traces) {
      const trace = asRecord(traceValue);
      if (typeof trace.trace_id !== "string" || trace.trace_id.trim().length === 0) {
        errors.push("runtime trace must include traceId");
      }
      if (typeof trace.target_id !== "string" || trace.target_id.trim().length === 0) {
        errors.push(`runtime trace ${String(trace.trace_id)} must include targetId`);
      }
      if (!Array.isArray(trace.side_effects)) {
        errors.push(`runtime trace ${String(trace.trace_id)} must include sideEffects`);
      }
      if (!Array.isArray(trace.evidence_refs) || trace.evidence_refs.length === 0) {
        errors.push(`runtime trace ${String(trace.trace_id)} must include evidenceRefs`);
      }
      if (typeof trace.created_at !== "string" || trace.created_at.trim().length === 0) {
        errors.push(`runtime trace ${String(trace.trace_id)} must include createdAt`);
      }
    }
  }

  if (errors.length > 0) {
    failRaw(
      `archon workflow check failed: invalid coverage ledger artifact ${manifestPath}: ${errors.join("; ")}`
    );
  }
}

function validateProgressProofArtifact(artifactPath: string): void {
  const artifact = asRecord(readJsonOrFail(artifactPath));
  const errors: string[] = [];

  const coverageDelta = asRecord(artifact.coverage_delta);
  const hasCoverageDelta = Object.values(coverageDelta).some(
    (value) => typeof value === "number" && Number.isFinite(value) && value !== 0
  );
  const blockingGapDelta = asRecord(artifact.blocking_gap_delta);
  const hasGapDelta =
    (typeof blockingGapDelta.closed === "number" && blockingGapDelta.closed !== 0) ||
    (typeof blockingGapDelta.opened === "number" && blockingGapDelta.opened !== 0);

  if (!Number.isInteger(artifact.cycle) || (artifact.cycle as number) <= 0) {
    errors.push("cycle must be a positive integer");
  }

  if (!Array.isArray(artifact.evidence_refs) || artifact.evidence_refs.length === 0) {
    errors.push("evidence_refs must contain at least one entry");
  }

  if (typeof artifact.next_target !== "string" || artifact.next_target.trim().length === 0) {
    errors.push("next_target must be non-empty");
  }

  if (typeof artifact.why_next !== "string" || artifact.why_next.trim().length === 0) {
    errors.push("why_next must be non-empty");
  }

  if (!hasCoverageDelta && !hasGapDelta) {
    errors.push("progress proof must record a measurable delta");
  }

  if (errors.length > 0) {
    failRaw(
      `archon workflow check failed: invalid progress proof artifact ${artifactPath}: ${errors.join("; ")}`
    );
  }
}

function validateTaskQueue(queuePath: string, currentTaskId: string, currentActiveState: string): void {
  const queue = asRecord(readJsonOrFail(queuePath));
  const tasks = Array.isArray(queue.tasks) ? queue.tasks : [];
  const queueCurrentTaskId = queue.current_task_id ?? null;

  const target = tasks.find((task) => asRecord(task).id === currentTaskId);
  if (!target) {
    failRaw(`archon workflow check failed: task queue is missing current task "${currentTaskId}"`);
  }

  if (currentActiveState === "active" && queueCurrentTaskId !== currentTaskId) {
    failRaw(
      `archon workflow check failed: task queue current_task_id "${String(queueCurrentTaskId)}" does not match active task "${currentTaskId}"`
    );
  }

  for (const taskValue of tasks) {
    if (!taskValue || typeof taskValue !== "object") {
      failRaw("archon workflow check failed: task queue contains a non-object task entry");
    }
    const task = asRecord(taskValue);

    if (task.class === "docs_only") {
      continue;
    }

    const requiredFields: Array<[string, string]> = [
      ["acceptance_criteria", "acceptance criterion"],
      ["verification", "verification step"],
      ["evidence", "evidence reference"]
    ];
    for (const [field, label] of requiredFields) {
      const itemsValue = task[field];
      const items = Array.isArray(itemsValue) ? itemsValue : [];
      const normalized = items
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      if (normalized.length === 0) {
        failRaw(
          `archon workflow check failed: task queue task "${String(task.id)}" must include at least one ${label}`
        );
      }
    }
  }
}

function requireArtifactRefPath(key: string, value: string, filePath: string): void {
  let expectedPrefix = "";
  switch (key) {
    case "brief":
      expectedPrefix = ".archon/work/briefs/";
      break;
    case "plan":
      expectedPrefix = ".archon/work/plans/";
      break;
    case "task":
      expectedPrefix = ".archon/work/tasks/";
      break;
    case "reviewer":
    case "qa_engineer":
    case "security_reviewer":
      expectedPrefix = ".archon/work/reviews/";
      break;
    default:
      fail(`unsupported workflow artifact ref key ${key} in ${rel(filePath)}`);
  }

  if (value.startsWith("/")) {
    fail(`workflow artifact ref ${key} must be repo-relative in ${rel(filePath)}`);
  }
  if (value.includes("..")) {
    fail(`workflow artifact ref ${key} must not contain .. in ${rel(filePath)}`);
  }
  if (!value.startsWith(expectedPrefix)) {
    fail(`workflow artifact ref ${key} must stay under ${expectedPrefix} in ${rel(filePath)}`);
  }
}

function sectionMentionsValue(heading: string, needle: string, filePath: string): boolean {
  return extractSectionBlock(heading, filePath).includes(needle);
}

function requireArtifactOverrideReference(label: string, value: string, filePath: string): void {
  if (sectionMentionsValue("## Inputs", value, filePath)) {
    return;
  }
  if (sectionMentionsValue("## Dependencies", value, filePath)) {
    return;
  }
  fail(`${label} must also be listed in ## Inputs or ## Dependencies in ${rel(filePath)}: ${value}`);
}

const activeFile = path.join(repoRoot, ".archon/ACTIVE");
const agentsFile = path.join(repoRoot, "AGENTS.md");
const configFile = path.join(repoRoot, ".codex/config.toml");
const briefTemplate = path.join(repoRoot, ".archon/templates/intake-brief.md");
const taskTemplate = path.join(repoRoot, ".archon/templates/task-packet.md");
const reviewTemplate = path.join(repoRoot, ".archon/templates/review-gate.md");
const coverageManifestTemplate = path.join(repoRoot, ".archon/templates/coverage-manifest.json");
const checkpointTemplate = path.join(repoRoot, ".archon/templates/checkpoint-summary.md");
const progressProofTemplate = path.join(repoRoot, ".archon/templates/progress-proof.json");

requireFile(activeFile);
requireFile(agentsFile);
requireFile(configFile);
requireFile(briefTemplate);
requireFile(taskTemplate);
requireFile(reviewTemplate);
requireFile(coverageManifestTemplate);
requireFile(checkpointTemplate);
requireFile(progressProofTemplate);

const contractMode = readFileOrFail(agentsFile).includes("workflow_runtime=postgres")
  ? "runtime"
  : "legacy";

const activeFields: Record<string, string> = {};
for (const rawLine of fileLines(activeFile)) {
  const line = rawLine.replace(/\r$/, "");
  if (line === "") {
    continue;
  }
  const separator = line.indexOf("=");
  if (separator === -1) {
    fail("unexpected .archon/ACTIVE content");
  }
  const key = line.slice(0, separator);
  const value = line.slice(separator + 1);
  if (key !== "task_id" && key !== "workflow" && key !== "state") {
    fail(`unexpected key ${key} in .archon/ACTIVE`);
  }
  if (Object.prototype.hasOwnProperty.call(activeFields, key)) {
    fail(`duplicate ${key} in .archon/ACTIVE`);
  }
  activeFields[key] = value;
}

if (activeFields.workflow !== "archon") {
  fail("workflow must be archon in .archon/ACTIVE");
}

const activeState = activeFields.state ?? "";
if (activeState === "") {
  fail("missing state in .archon/ACTIVE");
}
if (activeState !== "active" && activeState !== "idle" && activeState !== "complete") {
  fail("state must be active, idle, or complete in .archon/ACTIVE");
}

const exportedTaskId = activeFields.task_id ?? "";
if (exportedTaskId !== "") {
  validateTaskId(exportedTaskId);
}

let taskId = "";
if (activeState === "active") {
  if (exportedTaskId === "") {
    fail("missing task_id in .archon/ACTIVE");
  }
  taskId = exportedTaskId;
  if (requestedTaskId !== "" && requestedTaskId !== taskId) {
    fail(`requested task id ${requestedTaskId} does not match active task ${taskId}`);
  }
} else if (requestedTaskId !== "") {
  taskId = requestedTaskId;
} else if (exportedTaskId !== "") {
  taskId = exportedTaskId;
} else {
  fail("non-active .archon/ACTIVE requires --task-id");
}

requireContractEquals("workflow", "archon", agentsFile);
requireContractEquals("required_review_roles", "reviewer,qa_engineer,security_reviewer", agentsFile);
requireContractEquals("release_candidate_quality_gate", "release_readiness_required", agentsFile);
requireContractEquals(
  "local_live_check",
  "bash scripts/check-archon-workflow-live.sh [--task-id <task-id>]",
  agentsFile
);

if (contractMode === "legacy") {
  requireContractEquals("active_file", ".archon/ACTIVE", agentsFile);
  requireContractEquals("brief_file", ".archon/work/briefs/brief-<task-id>.md", agentsFile);
  requireContractEquals("plan_file", ".archon/work/plans/plan-<task-id>.md", agentsFile);
  requireContractEquals("task_file", ".archon/work/tasks/task-<task-id>.md", agentsFile);
  requireContractEquals("review_file", ".archon/work/reviews/review-<task-id>-<role>.md", agentsFile);
  requireContractEquals("brief_template", ".archon/templates/intake-brief.md", agentsFile);
  requireContractEquals("task_template", ".archon/templates/task-packet.md", agentsFile);
  requireContractEquals("review_template", ".archon/templates/review-gate.md", agentsFile);
  requireContractEquals(
    "review_aliases",
    "reviewer:reviewer;qa_engineer:qa|qa_engineer;security_reviewer:security|security_reviewer",
    agentsFile
  );
  requireContractEquals(
    "workflow_check",
    "node --experimental-strip-types scripts/check-archon-workflow.ts --task-id <task-id>",
    agentsFile
  );
  requireContractEquals("workflow_check_scope", "artifact_contract_only", agentsFile);
  requireContractEquals("review_artifact_trust", "manager_summary_evidence_only", agentsFile);
  requireContractEquals("ci_scope", "artifact_contract_regression_fixtures_only", agentsFile);
} else {
  requireContractEquals("workflow_runtime", "postgres", agentsFile);
  requireContractEquals("active_run_pointer", "project_runtime_state.active_run_id", agentsFile);
  requireContractEquals("active_task_pointer", "project_runtime_state.active_task_id", agentsFile);
  requireContractEquals("workflow_documents", "workflow_documents", agentsFile);
  requireContractEquals("task_queue", "project_runtime_state.task_queue", agentsFile);
  requireContractEquals("product_state", "project_runtime_state.product_state", agentsFile);
  requireContractEquals("review_authority", "runtime_orchestrated_only", agentsFile);
  requireContractEquals("workflow_check_scope", "runtime_authority_only", agentsFile);
  requireContractEquals("review_artifact_trust", "runtime_records_only", agentsFile);
  requireContractEquals("ci_scope", "runtime_contract_and_export_regressions", agentsFile);
}

requireGrep("AGENTS.md", configFile);
requireGrep(".agents.md", configFile);

requireSectionEquals("## Task ID", "<task-id>", briefTemplate);
requireHeading("## Success Criteria", briefTemplate);
requireHeading("## Stop Go", briefTemplate);
requireSectionEquals("## Stop Go", "go | needs_review | stop", briefTemplate);

requireSectionEquals("## Task ID", "<task-id>", taskTemplate);
requireSectionEquals("## Owner role", "<owner-role>", taskTemplate);
requireSectionEquals("## Completion standard", "artifact_complete | specialist_verified", taskTemplate);
requireHeading("## Required specialist roles", taskTemplate);
requireHeading("## Quality gates", taskTemplate);
requireHeading("## Acceptance criteria", taskTemplate);
requireHeading("## Verification steps", taskTemplate);
requireHeading("## Required reviews", taskTemplate);
requireHeading("## Reasoning quality", taskTemplate);
requireHeading("## Reasoning policy", taskTemplate);
requireHeading("## Reasoning attempts", taskTemplate);
requireHeading("## Coverage impact", taskTemplate);
requireHeading("## Touched ledger items", taskTemplate);
requireHeading("## Required runtime traces", taskTemplate);
requireHeading("## Progress proof", taskTemplate);
requireHeading("## Interrupt checkpoint policy", taskTemplate);
requireGrep("`reviewer`", taskTemplate);
requireGrep("`qa_engineer`", taskTemplate);
requireGrep("`security_reviewer`", taskTemplate);
requireHeading("## Rollback notes", taskTemplate);

requireSectionEquals("## Task ID", "<task-id>", reviewTemplate);
requireSectionEquals("## Reviewer role", "reviewer | qa_engineer | security_reviewer", reviewTemplate);
requireSectionEquals("## Actor", "<recorded-actor-id>", reviewTemplate);
requireSectionEquals(
  "## Actor role",
  "reviewer | qa_engineer | security_reviewer | planner | solution_architect",
  reviewTemplate
);
requireSectionEquals(
  "## Provenance status",
  "summary_only | runtime_verified | legacy_backfill",
  reviewTemplate
);
requireSectionEquals("## Review state", "pending | passed | blocked | waived", reviewTemplate);
requireSectionEquals("## Severity", "low | medium | high | critical", reviewTemplate);
requireHeading("## Specialist execution evidence", reviewTemplate);
requireHeading("## Quality gate evidence", reviewTemplate);
requireHeading("## Reasoning quality findings", reviewTemplate);
requireHeading("## Verification evidence", reviewTemplate);
requireSectionEquals("## Waiver authority", "none | manager | security_exception", reviewTemplate);
requireSectionEquals("## Decision", "approved | blocked | waived", reviewTemplate);
requireHeading("## Source handoff", reviewTemplate);

const artifactTaskId = taskId;
let briefRel = `.archon/work/briefs/brief-${artifactTaskId}.md`;
let planRel = `.archon/work/plans/plan-${artifactTaskId}.md`;
const taskRel = `.archon/work/tasks/task-${artifactTaskId}.md`;
const taskFile = path.join(repoRoot, taskRel);
let reviewerRel = "";
let qaEngineerRel = "";
let securityReviewerRel = "";
let reviewExportPolicy = "required";

if (isFile(path.join(repoRoot, planRel))) {
  requireSectionEquals("## Task ID", taskId, path.join(repoRoot, planRel));
} else if (isFile(taskFile)) {
  requireSectionEquals("## Task ID", taskId, taskFile);
} else {
  fail(`missing current plan or task artifact for ${taskId}`);
}

let taskCompletionStandard = "artifact_complete";
if (isFile(taskFile)) {
  requireSectionEquals("## Task ID", taskId, taskFile);
  taskCompletionStandard = normalizeValue(extractSectionValue("## Completion standard", taskFile));
  requireAllowedValue(taskCompletionStandard, taskFile, "artifact_complete", "specialist_verified");

  if (readFileOrFail(taskFile).includes("## Workflow artifact refs")) {
    for (const key of ["brief", "plan", "task", "reviewer", "qa_engineer", "security_reviewer"]) {
      const value = normalizeValue(extractSectionKeyValue("## Workflow artifact refs", key, taskFile));
      if (value === "") {
        continue;
      }
      requireArtifactRefPath(key, value, taskFile);
      switch (key) {
        case "brief":
          briefRel = value;
          break;
        case "plan":
          planRel = value;
          break;
        case "task":
          if (value !== taskRel) {
            fail(`workflow artifact ref task must match current task artifact in ${rel(taskFile)}: ${taskRel}`);
          }
          break;
        case "reviewer":
          reviewerRel = value;
          break;
        case "qa_engineer":
          qaEngineerRel = value;
          break;
        case "security_reviewer":
          securityReviewerRel = value;
          break;
      }
    }

    reviewExportPolicy = normalizeValue(
      extractSectionKeyValue("## Workflow artifact refs", "review_exports", taskFile)
    );
    if (reviewExportPolicy === "") {
      reviewExportPolicy = "required";
    }
    requireAllowedValue(reviewExportPolicy, taskFile, "required", "runtime_optional");
    if (reviewExportPolicy === "runtime_optional" && contractMode !== "runtime") {
      fail(`review_exports=runtime_optional requires runtime workflow contract in ${rel(taskFile)}`);
    }
  }

  if (taskCompletionStandard === "specialist_verified") {
    const specialistRolesBlock = extractSectionBlock("## Required specialist roles", taskFile);
    const qualityGatesBlock = extractSectionBlock("## Quality gates", taskFile);
    if (normalizeValue(specialistRolesBlock).trim() === "") {
      fail(`missing required specialist roles in ${rel(taskFile)}`);
    }
    if (normalizeValue(qualityGatesBlock).trim() === "") {
      fail(`missing quality gates in ${rel(taskFile)}`);
    }
  }
}

const briefFile = path.join(repoRoot, briefRel);
const planFile = path.join(repoRoot, planRel);

requireFile(briefFile);
const briefSectionTaskId = normalizeValue(extractSectionValue("## Task ID", briefFile));
if (briefSectionTaskId === "") {
  fail(`missing section value ## Task ID in ${rel(briefFile)}`);
}
validateTaskId(briefSectionTaskId);
if (briefRel === `.archon/work/briefs/brief-${artifactTaskId}.md`) {
  if (briefSectionTaskId !== taskId) {
    fail(`unexpected value for ## Task ID in ${rel(briefFile)}: expected ${taskId}`);
  }
} else {
  if (!isFile(taskFile)) {
    fail(`workflow brief override requires current task artifact for ${taskId}`);
  }
  requireArtifactOverrideReference("workflow brief ref", briefRel, taskFile);
}

if (isFile(planFile)) {
  const planSectionTaskId = normalizeValue(extractSectionValue("## Task ID", planFile));
  if (planSectionTaskId === "") {
    fail(`missing section value ## Task ID in ${rel(planFile)}`);
  }
  validateTaskId(planSectionTaskId);
  if (planRel === `.archon/work/plans/plan-${artifactTaskId}.md`) {
    if (planSectionTaskId !== taskId) {
      fail(`unexpected value for ## Task ID in ${rel(planFile)}: expected ${taskId}`);
    }
  } else {
    if (!isFile(taskFile)) {
      fail(`workflow plan override requires current task artifact for ${taskId}`);
    }
    requireArtifactOverrideReference("workflow plan ref", planRel, taskFile);
  }
}

if (liveMode) {
  if (!isFile(taskFile)) {
    fail(`live workflow requires current task artifact for ${taskId}`);
  }

  for (const heading of [
    "## Owner role",
    "## Completion standard",
    "## Required specialist roles",
    "## Quality gates",
    "## Reasoning quality",
    "## Goal",
    "## Inputs",
    "## Dependencies",
    "## Outputs",
    "## Coverage impact",
    "## Touched ledger items",
    "## Required runtime traces",
    "## Progress proof",
    "## Interrupt checkpoint policy",
    "## Workflow artifact refs",
    "## Allowed write scope",
    "## Out of scope",
    "## Assumptions",
    "## Acceptance criteria",
    "## Verification steps",
    "## Required reviews",
    "## Security checks",
    "## Retrieval guidance",
    "## Anti-patterns to avoid",
    "## Rollback notes",
    "## Handoff format"
  ]) {
    requireHeading(heading, taskFile);
  }

  requireHeading("### Approved assumptions", taskFile);
  requireHeading("### Blocked assumptions", taskFile);
  requireHeading("### Claim", taskFile);
  requireHeading("### Facts", taskFile);
  requireHeading("### Assumptions", taskFile);
  requireHeading("### Hypotheses and alternatives", taskFile);
  requireHeading("### Evidence refs", taskFile);
  requireHeading("### Counter-evidence", taskFile);
  requireHeading("### Confidence", taskFile);
  requireHeading("### Open questions", taskFile);
  requireHeading("### Verification plan", taskFile);
  requireHeading("### Research and debug budgets", taskFile);

  let reasoningMode = "legacy";
  if (readFileOrFail(taskFile).includes("## Reasoning policy")) {
    const reasoningModeRaw = extractSectionValue("### Mode", taskFile);
    if (reasoningModeRaw !== "") {
      reasoningMode = normalizeValue(reasoningModeRaw);
      requireAllowedValue(reasoningMode, taskFile, "legacy", "dual", "strict");
    }
  }

  if (reasoningMode !== "legacy") {
    requireHeading("## Reasoning policy", taskFile);
    requireHeading("### Mode", taskFile);
    requireHeading("### Requirements", taskFile);
    requireHeading("### Max attempts", taskFile);
    requireHeading("## Reasoning attempts", taskFile);
    requireHeading("### Attempt records", taskFile);
    requireHeading("### Verification records", taskFile);
    requireHeading("### Verdict", taskFile);
    requireNonemptySectionBlock("### Mode", taskFile);
    requireNonemptySectionBlock("### Requirements", taskFile);
    requireNonemptySectionBlock("### Max attempts", taskFile);
  }

  if (reasoningMode === "strict") {
    requireNonemptySectionBlock("### Attempt records", taskFile);
    requireNonemptySectionBlock("### Verification records", taskFile);
    requireNonemptySectionBlock("### Verdict", taskFile);
  }

  for (const heading of [
    "## Required specialist roles",
    "## Quality gates",
    "## Goal",
    "## Inputs",
    "## Dependencies",
    "## Outputs",
    "## Coverage impact",
    "## Touched ledger items",
    "## Required runtime traces",
    "## Progress proof",
    "## Interrupt checkpoint policy",
    "## Workflow artifact refs",
    "## Allowed write scope",
    "## Out of scope",
    "## Acceptance criteria",
    "## Verification steps",
    "## Required reviews",
    "## Security checks",
    "## Retrieval guidance",
    "## Anti-patterns to avoid",
    "## Rollback notes",
    "## Handoff format"
  ]) {
    requireNonemptySectionBlock(heading, taskFile);
  }

  for (const heading of [
    "### Claim",
    "### Facts",
    "### Assumptions",
    "### Hypotheses and alternatives",
    "### Evidence refs",
    "### Counter-evidence",
    "### Confidence",
    "### Verification plan",
    "### Research and debug budgets"
  ]) {
    requireNonemptySectionBlock(heading, taskFile);
  }

  const requiredReviewsBlock = extractSectionBlock("## Required reviews", taskFile);
  if (!requiredReviewsBlock.includes("reviewer")) {
    fail(`missing reviewer required review in ${rel(taskFile)}`);
  }
  if (!requiredReviewsBlock.includes("qa_engineer")) {
    fail(`missing qa_engineer required review in ${rel(taskFile)}`);
  }
  if (!requiredReviewsBlock.includes("security_reviewer")) {
    fail(`missing security_reviewer required review in ${rel(taskFile)}`);
  }

  const supportedQualityGates = new Set(loadSupportedQualityGates());
  const liveQualityGates = extractListItems("## Quality gates", taskFile);
  if (liveQualityGates.length === 0) {
    fail(`missing live quality gates in ${rel(taskFile)}`);
  }
  for (const gate of liveQualityGates) {
    if (!supportedQualityGates.has(gate)) {
      fail(`unsupported quality gate in ${rel(taskFile)}: ${gate}`);
    }
  }
}

let taskQualityGates: string[] = [];
let taskPlaywrightRequired = "false";

if (isFile(taskFile)) {
  taskQualityGates = extractListItems("## Quality gates", taskFile);
  let taskReasoningMode = "legacy";
  let taskUiSurface = "none";
  if (readFileOrFail(taskFile).includes("## Reasoning policy")) {
    const taskReasoningModeRaw = extractSectionValue("### Mode", taskFile);
    if (taskReasoningModeRaw !== "") {
      taskReasoningMode = normalizeValue(taskReasoningModeRaw);
      requireAllowedValue(taskReasoningMode, taskFile, "legacy", "dual", "strict");
    }
  }

  if (taskCompletionStandard === "specialist_verified") {
    let hasReasoningStrictGate = false;
    let hasStrongerArtifactGate = false;

    for (const gate of taskQualityGates) {
      if (gate === "reasoning_strict_required") {
        hasReasoningStrictGate = true;
      } else if (
        gate === "coverage_ledger_required" ||
        gate === "progress_proof_required" ||
        gate === "checkpoint_resume_required" ||
        gate === "memory_compaction_required"
      ) {
        hasStrongerArtifactGate = true;
      }
    }

    if (!hasReasoningStrictGate) {
      fail(`specialist_verified work requires reasoning_strict_required quality gate in ${rel(taskFile)}`);
    }
    if (taskReasoningMode !== "strict") {
      fail(`specialist_verified work requires strict reasoning mode in ${rel(taskFile)}`);
    }
    if (!hasStrongerArtifactGate) {
      fail(
        `specialist_verified work requires at least one stronger artifact gate (coverage_ledger_required, progress_proof_required, checkpoint_resume_required, or memory_compaction_required) in ${rel(taskFile)}`
      );
    }
  }

  if (readFileOrFail(taskFile).includes("## UI surface")) {
    taskUiSurface = normalizeValue(extractSectionValue("## UI surface", taskFile));
    requireAllowedValue(taskUiSurface, taskFile, "none", "visual_change", "interactive_flow");
  }

  if (readFileOrFail(taskFile).includes("## Playwright requirement")) {
    taskPlaywrightRequired = normalizeValue(extractSectionValue("## Playwright requirement", taskFile));
    requireAllowedValue(taskPlaywrightRequired, taskFile, "true", "false");
  }

  if (taskUiSurface === "visual_change" || taskUiSurface === "interactive_flow") {
    if (taskPlaywrightRequired !== "true") {
      fail(`ui surface ${taskUiSurface} must require Playwright in ${rel(taskFile)}`);
    }
  }

  if (taskQualityGates.includes("council_review_required")) {
    requireHeading("## Council review", taskFile);
    requireHeading("### Required", taskFile);
    requireHeading("### Trigger rationale", taskFile);
    requireHeading("### Decision packet", taskFile);
    requireHeading("### Council members", taskFile);
    requireHeading("### Dissent owner", taskFile);
    requireHeading("### Outcome", taskFile);
    requireHeading("### Exception expiry", taskFile);

    const councilRequired = normalizeValue(extractSectionValue("### Required", taskFile));
    const councilOutcome = normalizeValue(extractSectionValue("### Outcome", taskFile));
    const councilDissentOwner = normalizeValue(extractSectionValue("### Dissent owner", taskFile));
    const councilPacketBlock = extractSectionBlock("### Decision packet", taskFile);
    const councilMembersBlock = extractSectionBlock("### Council members", taskFile);
    const councilTriggerBlock = extractSectionBlock("### Trigger rationale", taskFile);

    requireAllowedValue(councilRequired, taskFile, "true", "false", "inherited");
    requireAllowedValue(
      councilOutcome,
      taskFile,
      "pending",
      "approved",
      "approved_with_conditions",
      "rework_required",
      "exception_granted",
      "rejected",
      "inherited"
    );
    if (councilDissentOwner === "") {
      fail(`council_review_required tasks must name a dissent owner in ${rel(taskFile)}`);
    }
    if (normalizeValue(councilPacketBlock).trim() === "") {
      fail(`council_review_required tasks must cite a decision packet in ${rel(taskFile)}`);
    }
    if (normalizeValue(councilMembersBlock).trim() === "") {
      fail(`council_review_required tasks must list council members in ${rel(taskFile)}`);
    }
    if (normalizeValue(councilTriggerBlock).trim() === "") {
      fail(`council_review_required tasks must record trigger rationale in ${rel(taskFile)}`);
    }
  }

  const coverageManifestFile = path.join(repoRoot, `.archon/work/coverage/coverage-${artifactTaskId}.json`);
  const coverageItemsFile = path.join(repoRoot, `.archon/work/coverage/items-${artifactTaskId}.json`);
  const coverageGapsFile = path.join(repoRoot, `.archon/work/coverage/gaps-${artifactTaskId}.json`);
  const coverageDependencyGraphFile = path.join(
    repoRoot,
    `.archon/work/coverage/dependency-graph-${artifactTaskId}.json`
  );
  const coverageTracesFile = path.join(repoRoot, `.archon/work/coverage/traces-${artifactTaskId}.json`);
  const progressProofFile = path.join(repoRoot, `.archon/work/proofs/progress-${artifactTaskId}.json`);
  const checkpointFile = path.join(repoRoot, `.archon/work/checkpoints/checkpoint-${artifactTaskId}.md`);

  for (const gate of taskQualityGates) {
    switch (gate) {
      case "coverage_ledger_required":
        requireFile(coverageManifestFile);
        requireFile(coverageItemsFile);
        requireFile(coverageGapsFile);
        requireFile(coverageDependencyGraphFile);
        requireFile(coverageTracesFile);
        validateCoverageLedgerArtifacts(
          coverageManifestFile,
          coverageItemsFile,
          coverageGapsFile,
          coverageDependencyGraphFile,
          coverageTracesFile
        );
        break;
      case "progress_proof_required":
        requireFile(progressProofFile);
        validateProgressProofArtifact(progressProofFile);
        break;
      case "checkpoint_resume_required":
        requireFile(checkpointFile);
        break;
      case "memory_compaction_required":
        requireFile(checkpointFile);
        requireGrep("memory://", checkpointFile);
        break;
    }
  }
}

const queueFile = path.join(repoRoot, ".archon/work/task-queue.json");
if (isFile(queueFile)) {
  validateTaskQueue(queueFile, taskId, activeState);
}

function resolveReviewFile(
  explicitRel: string,
  reviewBase: string,
  shortRole: string,
  fullRole: string
): string {
  if (explicitRel !== "") {
    const explicitPath = path.join(repoRoot, explicitRel);
    if (isFile(explicitPath)) {
      return explicitPath;
    }
    if (reviewExportPolicy === "runtime_optional") {
      return "";
    }
    fail(`missing review file for ${fullRole}: expected ${explicitRel}`);
  }

  const shortPath = path.join(repoRoot, `.archon/work/reviews/review-${reviewBase}-${shortRole}.md`);
  const fullPath = path.join(repoRoot, `.archon/work/reviews/review-${reviewBase}-${fullRole}.md`);

  if (shortRole === fullRole) {
    if (isFile(shortPath)) {
      return shortPath;
    }
    if (reviewExportPolicy === "runtime_optional") {
      return "";
    }
    fail(`missing review file for ${fullRole}: expected ${rel(shortPath)}`);
  }

  if (isFile(shortPath) && isFile(fullPath)) {
    fail(`duplicate review files for ${fullRole}: ${rel(shortPath)} and ${rel(fullPath)}`);
  }

  if (isFile(shortPath)) {
    return shortPath;
  }

  if (isFile(fullPath)) {
    return fullPath;
  }

  if (reviewExportPolicy === "runtime_optional") {
    return "";
  }

  fail(`missing review file for ${fullRole}: expected ${rel(shortPath)} or ${rel(fullPath)}`);
}

const roles = ["reviewer", "qa", "security"] as const;

for (const role of roles) {
  let expectedRole = "";
  let reviewFile = "";
  switch (role) {
    case "reviewer":
      expectedRole = "reviewer";
      reviewFile = resolveReviewFile(reviewerRel, artifactTaskId, "reviewer", "reviewer");
      break;
    case "qa":
      expectedRole = "qa_engineer";
      reviewFile = resolveReviewFile(qaEngineerRel, artifactTaskId, "qa", "qa_engineer");
      break;
    case "security":
      expectedRole = "security_reviewer";
      reviewFile = resolveReviewFile(securityReviewerRel, artifactTaskId, "security", "security_reviewer");
      break;
  }

  if (reviewFile === "") {
    continue;
  }

  requireSectionEquals("## Task ID", taskId, reviewFile);
  requireSectionEquals("## Reviewer role", expectedRole, reviewFile);
  const actor = normalizeValue(extractSectionValue("## Actor", reviewFile));
  const actorRole = normalizeValue(extractSectionValue("## Actor role", reviewFile));
  const provenanceStatus = normalizeValue(extractSectionValue("## Provenance status", reviewFile));
  const reviewState = normalizeValue(extractSectionValue("## Review state", reviewFile));
  const decision = normalizeValue(extractSectionValue("## Decision", reviewFile));
  const severity = normalizeValue(extractSectionValue("## Severity", reviewFile));
  const waiverAuthorityValue = normalizeValue(extractSectionValue("## Waiver authority", reviewFile));
  const waiverReason = extractSectionValue("## Waiver reason", reviewFile);

  if (actor === "") {
    fail(`missing actor in ${rel(reviewFile)}`);
  }
  if (actorRole === "") {
    fail(`missing actor role in ${rel(reviewFile)}`);
  }
  requireAllowedValue(provenanceStatus, reviewFile, "summary_only", "runtime_verified", "legacy_backfill");
  if (externalReviewAuthority) {
    requireAllowedValue(reviewState, reviewFile, "pending", "passed", "blocked", "waived");
    requireAllowedValue(decision, reviewFile, "approved", "blocked", "waived");
  } else {
    requireAllowedValue(reviewState, reviewFile, "passed", "waived");
    requireAllowedValue(decision, reviewFile, "approved", "waived");
  }
  requireAllowedValue(severity, reviewFile, "low", "medium", "high", "critical");
  requireAllowedValue(waiverAuthorityValue, reviewFile, "none", "manager", "security_exception");

  if (liveMode && !externalReviewAuthority && provenanceStatus !== "runtime_verified") {
    fail(
      `live workflow requires runtime_verified provenance for satisfying review ${expectedRole} in ${rel(reviewFile)}`
    );
  }

  if (expectedRole === "security_reviewer" && reviewState === "passed" && decision === "approved") {
    if (severity === "high" || severity === "critical") {
      fail(
        `passed security review summaries must use low or medium severity, not ${severity} in ${rel(reviewFile)}`
      );
    }
  }

  if (
    taskCompletionStandard === "specialist_verified" &&
    !externalReviewAuthority &&
    provenanceStatus !== "runtime_verified"
  ) {
    fail(`specialist_verified work requires runtime_verified review provenance in ${rel(reviewFile)}`);
  }

  if (externalReviewAuthority) {
    // External authority records review outcomes; allowed-value checks above apply.
  } else if (reviewState === "passed" && decision === "approved") {
    if (actorRole !== expectedRole) {
      fail(`passed review summary must record actor role ${expectedRole} in ${rel(reviewFile)}`);
    }
    if (waiverAuthorityValue !== "none") {
      fail(`passed review summary must use waiver authority none in ${rel(reviewFile)}`);
    }
    if (expectedRole === "security_reviewer" && (severity === "high" || severity === "critical")) {
      fail(`unresolved ${severity} security findings block completion in ${rel(reviewFile)}`);
    }
  } else if (reviewState === "waived" && decision === "waived") {
    switch (expectedRole) {
      case "reviewer":
      case "qa_engineer":
        if (actorRole !== "planner" && actorRole !== "solution_architect") {
          fail(
            `waived ${expectedRole} review summary must record planner or solution_architect actor role in ${rel(reviewFile)}`
          );
        }
        if (waiverAuthorityValue !== "manager") {
          fail(`waived ${expectedRole} review summary must use manager waiver authority in ${rel(reviewFile)}`);
        }
        break;
      case "security_reviewer":
        if (actorRole !== "security_reviewer") {
          fail(`waived security review summary must record security_reviewer actor role in ${rel(reviewFile)}`);
        }
        if (waiverAuthorityValue !== "security_exception") {
          fail(`waived security review summary must use security_exception authority in ${rel(reviewFile)}`);
        }
        break;
    }
    const normalizedWaiverReason = normalizeValue(waiverReason);
    if (waiverReason === "" || normalizedWaiverReason === "None." || normalizedWaiverReason === "None") {
      fail(`waived review lacks waiver reason in ${rel(reviewFile)}`);
    }
  } else {
    fail(`unexpected gate outcome in ${rel(reviewFile)}: state=${reviewState} decision=${decision}`);
  }

  const findings = extractSectionValue("## Findings", reviewFile);
  const residualRisk = extractSectionValue("## Residual risk", reviewFile);
  const specialistExecutionEvidence = extractSectionValue("## Specialist execution evidence", reviewFile);
  const qualityGateEvidence = extractSectionValue("## Quality gate evidence", reviewFile);
  const verificationEvidence = extractSectionValue("## Verification evidence", reviewFile);
  const verificationEvidenceBlock = extractSectionBlock("## Verification evidence", reviewFile);
  if (findings === "") {
    fail(`missing findings in ${rel(reviewFile)}`);
  }
  if (residualRisk === "") {
    fail(`missing residual risk in ${rel(reviewFile)}`);
  }
  if (taskCompletionStandard === "specialist_verified") {
    if (specialistExecutionEvidence === "") {
      fail(`missing specialist execution evidence in ${rel(reviewFile)}`);
    }
    if (qualityGateEvidence === "") {
      fail(`missing quality gate evidence in ${rel(reviewFile)}`);
    }
  }
  if (verificationEvidence === "") {
    fail(`missing verification evidence in ${rel(reviewFile)}`);
  }
  const sourceHandoff = extractSectionValue("## Source handoff", reviewFile);
  const sourceHandoffBlock = extractSectionBlock("## Source handoff", reviewFile);
  if (sourceHandoff === "") {
    fail(`missing source handoff in ${rel(reviewFile)}`);
  }
  if (liveMode && !externalReviewAuthority) {
    requireRuntimeProofReference(verificationEvidenceBlock, reviewFile, "## Verification evidence");
    requireRuntimeProofReference(sourceHandoffBlock, reviewFile, "## Source handoff");
  }
  if (taskCompletionStandard === "specialist_verified" && provenanceStatus === "runtime_verified") {
    requireRuntimeProofReference(verificationEvidenceBlock, reviewFile, "## Verification evidence");
    requireRuntimeProofReference(sourceHandoffBlock, reviewFile, "## Source handoff");
  }
}

if (isFile(taskFile)) {
  if (taskPlaywrightRequired === "true") {
    const qaReviewFile = resolveReviewFile(qaEngineerRel, artifactTaskId, "qa", "qa_engineer");
    if (qaReviewFile === "") {
      fail(`playwright-required task is missing qa review export for ${artifactTaskId}`);
    }
    const qaVerificationBlock = extractSectionBlock("## Verification evidence", qaReviewFile);
    const qaSourceHandoffBlock = extractSectionBlock("## Source handoff", qaReviewFile);
    if (!/playwright/i.test(`${qaVerificationBlock}\n${qaSourceHandoffBlock}`)) {
      fail(`playwright-required task must cite Playwright evidence in qa review export ${rel(qaReviewFile)}`);
    }
  }

  if (taskQualityGates.includes("release_readiness_required")) {
    let releaseReadinessEvidenceFound = false;
    const releaseEvidencePattern = /release[-_ ]readiness|release overlay|setup replay|rollout/i;

    for (const role of roles) {
      let reviewFile = "";
      switch (role) {
        case "reviewer":
          reviewFile = resolveReviewFile(reviewerRel, artifactTaskId, "reviewer", "reviewer");
          break;
        case "qa":
          reviewFile = resolveReviewFile(qaEngineerRel, artifactTaskId, "qa", "qa_engineer");
          break;
        case "security":
          reviewFile = resolveReviewFile(securityReviewerRel, artifactTaskId, "security", "security_reviewer");
          break;
      }

      if (reviewFile === "") {
        continue;
      }

      const qualityGateBlock = extractSectionBlock("## Quality gate evidence", reviewFile);
      if (releaseEvidencePattern.test(qualityGateBlock)) {
        releaseReadinessEvidenceFound = true;
        break;
      }
    }

    if (!releaseReadinessEvidenceFound) {
      for (const heading of ["## Verification steps", "## Good-path checks", "## Progress proof"]) {
        const evidenceBlock = extractSectionBlock(heading, taskFile);
        if (releaseEvidencePattern.test(evidenceBlock)) {
          releaseReadinessEvidenceFound = true;
          break;
        }
      }
    }

    if (!releaseReadinessEvidenceFound) {
      fail(
        "release_readiness_required tasks must cite release-readiness evidence in review summaries or task verification artifacts"
      );
    }
  }
}

process.stdout.write(`archon workflow artifact check passed for ${taskId}\n`);
