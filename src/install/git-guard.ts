import { execFile } from "node:child_process";
import { chmod, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const requiredHookFiles = [".githooks/pre-commit", ".githooks/commit-msg"] as const;
const requiredGuardScripts = [
  "scripts/check-archon-branch-name.sh",
  "scripts/check-archon-git-guard.sh",
  "scripts/check-archon-commit-msg.sh"
] as const;

export interface GitGuardSetupSummary {
  hooksPath: string;
  repoRoot: string;
}

export interface GitGuardVerificationSummary {
  hooksPath?: string | undefined;
  ok: boolean;
  problems: string[];
  repoRoot: string;
}

async function runGit(args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd });
  return stdout.trim();
}

async function fileExistsAsRegularFile(filePath: string): Promise<boolean> {
  try {
    const fileStat = await stat(filePath);
    return fileStat.isFile();
  } catch {
    return false;
  }
}

export async function resolveGitRepoRoot(cwd = process.cwd()): Promise<string> {
  const repoRoot = await runGit(["rev-parse", "--show-toplevel"], cwd);
  if (!repoRoot) {
    throw new Error("Could not resolve the git repository root.");
  }
  return repoRoot;
}

export async function setupGitGuard(cwd = process.cwd()): Promise<GitGuardSetupSummary> {
  const repoRoot = await resolveGitRepoRoot(cwd);

  for (const relativePath of [...requiredHookFiles, ...requiredGuardScripts]) {
    const absolutePath = path.join(repoRoot, relativePath);
    if (!(await fileExistsAsRegularFile(absolutePath))) {
      throw new Error(`Missing git guard file: ${relativePath}`);
    }
  }

  await runGit(["config", "--local", "core.hooksPath", ".githooks"], repoRoot);

  if (process.platform !== "win32") {
    await Promise.all(
      requiredHookFiles.map((relativePath) => chmod(path.join(repoRoot, relativePath), 0o755))
    );
  }

  return {
    repoRoot,
    hooksPath: ".githooks"
  };
}

export async function verifyGitGuard(cwd = process.cwd()): Promise<GitGuardVerificationSummary> {
  const repoRoot = await resolveGitRepoRoot(cwd);
  const problems: string[] = [];
  let hooksPath: string | undefined;

  try {
    hooksPath = await runGit(["config", "--local", "--get", "core.hooksPath"], repoRoot);
  } catch {
    hooksPath = undefined;
  }

  if (hooksPath !== ".githooks") {
    problems.push(`git config core.hooksPath must be .githooks, found ${hooksPath ?? "unset"}`);
  }

  for (const relativePath of requiredHookFiles) {
    const absolutePath = path.join(repoRoot, relativePath);
    if (!(await fileExistsAsRegularFile(absolutePath))) {
      problems.push(`missing hook file: ${relativePath}`);
      continue;
    }

    if (process.platform !== "win32") {
      const fileStat = await stat(absolutePath);
      if ((fileStat.mode & 0o111) === 0) {
        problems.push(`hook file is not executable: ${relativePath}`);
      }
    }
  }

  for (const relativePath of requiredGuardScripts) {
    if (!(await fileExistsAsRegularFile(path.join(repoRoot, relativePath)))) {
      problems.push(`missing guard script: ${relativePath}`);
    }
  }

  if (!(await fileExistsAsRegularFile(path.join(repoRoot, ".archon/install-manifest.json")))) {
    problems.push("missing .archon/install-manifest.json");
  }

  return {
    repoRoot,
    hooksPath,
    ok: problems.length === 0,
    problems
  };
}
