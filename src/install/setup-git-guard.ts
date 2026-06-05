import { pathToFileURL } from "node:url";
import path from "node:path";
import { setupGitGuard } from "./git-guard.ts";

async function main(): Promise<void> {
  const summary = await setupGitGuard();
  console.log(`archon git guard configured in ${summary.repoRoot}`);
  console.log(`hooksPath: ${summary.hooksPath}`);
  console.log("override for intentional overlay maintenance: ARCHON_ALLOW_MANAGED_COMMITS=1 git commit ...");
}

const entryUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";

if (import.meta.url === entryUrl) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
