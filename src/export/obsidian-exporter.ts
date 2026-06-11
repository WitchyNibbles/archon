import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

// ─── types ────────────────────────────────────────────────────────────────────

export interface ReviewFinding {
  role: string;
  outcome: string;
  findings: readonly string[];
}

export interface CommitEntry {
  hash: string;
  message: string;
}

export interface ObsidianExportInput {
  taskId: string;
  taskPacketPath: string;
  reviewRecords: readonly ReviewFinding[];
  commitList: readonly CommitEntry[];
}

export interface ObsidianExportResult {
  skipped: boolean;
  skipReason?: string | undefined;
  vaultPath?: string | undefined;
  writtenPaths: string[];
  errors: string[];
}

// ─── security helpers ─────────────────────────────────────────────────────────

const SAFE_ID_PATTERN = /^[a-zA-Z0-9\-_.]+$/;

export function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9\-_.]/g, "-");
}

export function isValidId(value: string): boolean {
  return SAFE_ID_PATTERN.test(value) && value.length > 0;
}

export function rejectPathTraversal(value: string): void {
  if (value.includes("..")) {
    throw new Error(`Path traversal rejected: ${value}`);
  }
}

async function resolveVaultPath(rawVaultPath: string): Promise<string> {
  rejectPathTraversal(rawVaultPath);
  const absolute = path.resolve(rawVaultPath);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

function assertInsideVault(vaultPath: string, candidatePath: string): void {
  const relative = path.relative(vaultPath, candidatePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write outside configured vault: ${candidatePath}`);
  }
}

// ─── date helper ─────────────────────────────────────────────────────────────

function toDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ─── task packet parser ───────────────────────────────────────────────────────

interface ParsedTaskPacket {
  goal: string;
  constraints: string;
  decisions: string[];
  relatedTasks: string[];
}

function parseTaskPacket(raw: string): ParsedTaskPacket {
  const sections = new Map<string, string[]>();
  let currentSection = "";
  for (const line of raw.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+)/);
    if (heading) {
      currentSection = heading[1].trim().toLowerCase();
      sections.set(currentSection, []);
    } else if (currentSection) {
      sections.get(currentSection)?.push(line);
    }
  }

  const sectionText = (name: string): string =>
    (sections.get(name) ?? []).join("\n").trim();

  const goal = sectionText("goal");
  const constraints = sectionText("constraints") || sectionText("out of scope") || sectionText("allowed write scope");

  const decisionLines = sections.get("key decisions") ?? sections.get("decisions") ?? [];
  const decisions = decisionLines
    .map((l) => l.replace(/^[-*]\s*/, "").trim())
    .filter((l) => l.length > 0);

  const depLines = sections.get("depends on") ?? sections.get("dependencies") ?? [];
  const relatedTasks = depLines
    .map((l) => l.replace(/^[-*`]\s*/g, "").replace(/`/g, "").trim())
    .filter((l) => l.length > 0);

  return { goal, constraints, decisions, relatedTasks };
}

// ─── note builders ────────────────────────────────────────────────────────────

function buildTaskClosureNote(input: {
  taskId: string;
  date: string;
  packet: ParsedTaskPacket;
  reviewRecords: readonly ReviewFinding[];
  commitList: readonly CommitEntry[];
}): string {
  const findReview = (role: string): ReviewFinding | undefined =>
    input.reviewRecords.find((r) => r.role === role);

  const reviewSection = (label: string, record: ReviewFinding | undefined): string => {
    if (!record) {
      return `### ${label}\n_no record_`;
    }
    const lines = [`### ${label}`, `outcome: ${record.outcome}`];
    for (const finding of record.findings) {
      lines.push(`- ${finding}`);
    }
    return lines.join("\n");
  };

  const commitsSection =
    input.commitList.length > 0
      ? input.commitList.map((c) => `- ${c.hash} ${c.message}`).join("\n")
      : "_none_";

  const relatedLinks =
    input.packet.relatedTasks.length > 0
      ? "\n" + input.packet.relatedTasks.map((t) => `[[${sanitizeId(t)}]]`).join(" ")
      : "";

  const lines = [
    "---",
    `task_id: ${input.taskId}`,
    `date: ${input.date}`,
    `status: complete`,
    `tags: [archon/task]`,
    "---",
    "",
    `# Task: ${input.taskId}`,
    "",
    "## Goal",
    input.packet.goal || "_not recorded_",
    "",
    "## Constraints",
    input.packet.constraints || "_none_",
    "",
    "## Key Decisions",
    input.packet.decisions.length > 0
      ? input.packet.decisions.map((d) => `- ${d}`).join("\n")
      : "_none_",
    "",
    "## Review Findings",
    reviewSection("Reviewer", findReview("reviewer")),
    "",
    reviewSection("QA Engineer", findReview("qa_engineer")),
    "",
    reviewSection("Security Reviewer", findReview("security_reviewer")),
    "",
    "## Commits",
    commitsSection,
    "",
    "## Lessons Learned",
    "",
    relatedLinks
  ];

  return lines.join("\n").trim() + "\n";
}

function buildDecisionNote(input: {
  date: string;
  taskId: string;
  taskNoteRelPath: string;
  decisionTitle: string;
  context: string;
  choice: string;
  agentName?: string | undefined;
}): string {
  const related = [`[[${input.taskNoteRelPath}]]`];
  if (input.agentName) {
    related.push(`[[Agents/${sanitizeId(input.agentName)}]]`);
  }

  return [
    "---",
    `date: ${input.date}`,
    `task_id: ${input.taskId}`,
    `tags: [archon/decision]`,
    "---",
    "",
    `# Decision: ${input.decisionTitle}`,
    "",
    "## Context",
    input.context || "_not recorded_",
    "",
    "## Choice Made",
    input.choice || "_not recorded_",
    "",
    "## Related",
    related.join(" ")
  ]
    .join("\n")
    .trim() + "\n";
}

function buildReviewSummaryNote(input: {
  taskId: string;
  date: string;
  taskNoteRelPath: string;
  record: ReviewFinding;
}): string {
  return [
    "---",
    `task_id: ${input.taskId}`,
    `role: ${input.record.role}`,
    `date: ${input.date}`,
    `outcome: ${input.record.outcome}`,
    `tags: [archon/review]`,
    "---",
    "",
    `# Review: ${input.taskId} — ${input.record.role}`,
    "",
    "## Findings",
    input.record.findings.length > 0
      ? input.record.findings.map((f) => `- ${f}`).join("\n")
      : "_no findings_",
    "",
    "## Reference",
    `[[${input.taskNoteRelPath}]]`
  ]
    .join("\n")
    .trim() + "\n";
}

function buildAgentProfileNote(agentContent: string): string {
  return agentContent.trim() + "\n";
}

// ─── file I/O helpers ─────────────────────────────────────────────────────────

async function writeVaultNote(
  vaultPath: string,
  relativePath: string,
  content: string
): Promise<string> {
  const fullPath = path.resolve(vaultPath, relativePath);
  assertInsideVault(vaultPath, fullPath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
  return fullPath;
}

async function readAgentMd(
  agentName: string,
  repoRoot?: string | undefined
): Promise<string | undefined> {
  const agentDir = sanitizeId(agentName).replace(/_/g, "-");
  const candidates = [
    ...(repoRoot
      ? [path.join(repoRoot, ".claude", "agents", agentDir, "AGENT.md")]
      : []),
    path.join(process.cwd(), ".claude", "agents", agentDir, "AGENT.md")
  ];

  for (const candidate of candidates) {
    try {
      return await readFile(candidate, "utf8");
    } catch {
      // try next candidate
    }
  }

  return undefined;
}

// ─── main exporter ────────────────────────────────────────────────────────────

export async function exportTaskToObsidian(
  input: ObsidianExportInput,
  options: {
    env?: NodeJS.ProcessEnv | undefined;
    repoRoot?: string | undefined;
    now?: Date | undefined;
  } = {}
): Promise<ObsidianExportResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const date = toDateString(now);

  // 1. check vault env var — missing is a soft skip, not an error
  const rawVaultPath = env["ARCHON_OBSIDIAN_VAULT"]?.trim();
  if (!rawVaultPath) {
    process.stderr.write(
      "[obsidian-exporter] ARCHON_OBSIDIAN_VAULT is not set — skipping export\n"
    );
    return {
      skipped: true,
      skipReason: "ARCHON_OBSIDIAN_VAULT not set",
      writtenPaths: [],
      errors: []
    };
  }

  // 2. security: reject path traversal in task-id
  const taskId = input.taskId.trim();

  try {
    rejectPathTraversal(taskId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[obsidian-exporter] ${message}\n`);
    return { skipped: true, skipReason: message, writtenPaths: [], errors: [message] };
  }

  if (!isValidId(taskId)) {
    const reason = `task-id contains unsafe characters and cannot be used as a filename: ${taskId}`;
    process.stderr.write(`[obsidian-exporter] ${reason}\n`);
    return { skipped: true, skipReason: reason, writtenPaths: [], errors: [reason] };
  }

  // 3. resolve vault path (also rejects traversal)
  let vaultPath: string;
  try {
    vaultPath = await resolveVaultPath(rawVaultPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[obsidian-exporter] vault path error: ${message}\n`);
    return { skipped: true, skipReason: message, writtenPaths: [], errors: [message] };
  }

  // 4. parse task packet (best-effort — missing/invalid → empty packet)
  let packet: ParsedTaskPacket;
  try {
    const raw = await readFile(input.taskPacketPath, "utf8");
    packet = parseTaskPacket(raw);
  } catch {
    packet = { goal: "", constraints: "", decisions: [], relatedTasks: [] };
  }

  const writtenPaths: string[] = [];
  const errors: string[] = [];

  // 5. task closure note
  const taskNoteFilename = `${date}-${taskId}`;
  const taskNoteRelPath = `Tasks/${taskNoteFilename}`;

  try {
    const content = buildTaskClosureNote({
      taskId,
      date,
      packet,
      reviewRecords: input.reviewRecords,
      commitList: input.commitList
    });
    const written = await writeVaultNote(vaultPath, `Tasks/${taskNoteFilename}.md`, content);
    writtenPaths.push(written);
  } catch (error) {
    errors.push(
      `task note: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // 6. decision notes — extracted from review findings prefixed with "decision:"
  const decisionRecords: Array<{
    title: string;
    context: string;
    choice: string;
    agentName?: string | undefined;
  }> = input.reviewRecords.flatMap((r) =>
    r.findings
      .filter((f) => f.toLowerCase().startsWith("decision:"))
      .map((f) => ({
        title: f.slice("decision:".length).trim().slice(0, 80),
        context: `From ${r.role} review of ${taskId}`,
        choice: f.slice("decision:".length).trim(),
        agentName: r.role
      }))
  );

  for (const decision of decisionRecords) {
    const slug = sanitizeId(
      decision.title
        .toLowerCase()
        .replace(/\s+/g, "-")
        .slice(0, 60)
    );
    if (!slug) {
      continue;
    }

    try {
      const content = buildDecisionNote({
        date,
        taskId,
        taskNoteRelPath,
        decisionTitle: decision.title,
        context: decision.context,
        choice: decision.choice,
        agentName: decision.agentName
      });
      const written = await writeVaultNote(vaultPath, `Decisions/${slug}.md`, content);
      writtenPaths.push(written);
    } catch (error) {
      errors.push(
        `decision note (${slug}): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // 7. review summary notes — one per review record
  for (const record of input.reviewRecords) {
    const safeRole = sanitizeId(record.role);
    const noteRelPath = `Reviews/${date}-${taskId}-${safeRole}`;

    try {
      const content = buildReviewSummaryNote({
        taskId,
        date,
        taskNoteRelPath,
        record
      });
      const written = await writeVaultNote(vaultPath, `${noteRelPath}.md`, content);
      writtenPaths.push(written);
    } catch (error) {
      errors.push(
        `review note (${safeRole}): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // 8. agent profile snapshots — best-effort, skip silently if AGENT.md not found
  const uniqueRoles = [...new Set(input.reviewRecords.map((r) => r.role))];
  for (const agentRole of uniqueRoles) {
    const safeRole = sanitizeId(agentRole);

    try {
      const agentMd = await readAgentMd(safeRole, options.repoRoot);
      if (!agentMd) {
        continue;
      }

      const content = buildAgentProfileNote(agentMd);
      const written = await writeVaultNote(vaultPath, `Agents/${safeRole}.md`, content);
      writtenPaths.push(written);
    } catch (error) {
      errors.push(
        `agent profile (${safeRole}): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return {
    skipped: false,
    vaultPath,
    writtenPaths,
    errors
  };
}
