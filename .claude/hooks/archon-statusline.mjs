// Statusline hook — Automatic context observer (R1).
//
// Claude Code fires the statusline command on each render with session JSON on
// stdin, including context_window.used_percentage. This is the only interactive
// surface that exposes context usage. We use it to keep .archon/work/context-guard.json
// in sync with the budget state so the PreToolUse hook can enforce the universal
// 70% handoff in interactive sessions (FR-6/FR-7, AC1/AC2).
//
// Best-effort: never throws — a failing statusline must not break the session.
// Always prints a single status line to stdout.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { computeStatuslineGuardUpdate } from "./hook-policy.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const fallbackRoot = path.resolve(scriptDir, "..", "..");

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// Honor the payload's working directory so the guard is written to the active
// project (and so the hook is testable in isolation). Fall back to the repo
// root the script lives in.
function resolveBaseDir(payload) {
  const fromWorkspace =
    payload && typeof payload === "object" && payload.workspace && typeof payload.workspace === "object"
      ? payload.workspace.current_dir
      : undefined;
  const candidate =
    (typeof fromWorkspace === "string" && fromWorkspace.trim().length > 0 && fromWorkspace) ||
    (typeof payload?.cwd === "string" && payload.cwd.trim().length > 0 && payload.cwd) ||
    fallbackRoot;
  return candidate;
}

function readExistingGuard(guardPath) {
  try {
    const parsed = JSON.parse(readFileSync(guardPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function persistGuard(guardPath, guard) {
  try {
    mkdirSync(path.dirname(guardPath), { recursive: true });
    writeFileSync(guardPath, `${JSON.stringify(guard)}\n`, "utf8");
  } catch {
    // best-effort
  }
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    payload = {};
  }

  let line = "archon ctx —";
  try {
    const guardPath = path.join(resolveBaseDir(payload), ".archon", "work", "context-guard.json");
    const existingGuard = readExistingGuard(guardPath);
    const update = computeStatuslineGuardUpdate(payload, existingGuard, process.env);
    if (update.guard) {
      persistGuard(guardPath, update.guard);
    }
    line = update.line;
  } catch {
    // best-effort: fall through to the neutral line
  }

  process.stdout.write(line);
}

main();
