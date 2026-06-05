import { pathToFileURL } from "node:url";
import path from "node:path";
import { verifyGitGuard } from "./git-guard.ts";

async function main(): Promise<void> {
  const summary = await verifyGitGuard();

  if (!summary.ok) {
    console.error(`archon git guard verification failed in ${summary.repoRoot}`);
    for (const problem of summary.problems) {
      console.error(`- ${problem}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`archon git guard verified in ${summary.repoRoot}`);
  console.log(`hooksPath: ${summary.hooksPath ?? ".githooks"}`);
}

const entryUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";

if (import.meta.url === entryUrl) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
