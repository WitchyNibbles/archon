#!/usr/bin/env node
// Regenerate the YAML frontmatter block of every shipped .claude/agents/*/AGENT.md
// from src/archon/agent-catalog.ts — the single source of truth. Only the leading
// `---`-delimited block is rewritten; body prose is left byte-for-byte untouched.
//
// USAGE
//   node --experimental-strip-types scripts/generate-agent-frontmatter.ts          # rewrite in place
//   node --experimental-strip-types scripts/generate-agent-frontmatter.ts --check  # CI drift gate (exit 1 on any diff)
//
// This is the procedure for a model-tier upgrade: edit MODEL_ALIAS_TO_ID in
// agent-catalog.ts, then run this script and commit the regenerated files in the
// SAME change. The tests/agent-frontmatter-generator.test.ts zero-drift test runs
// `--check` semantics so CI turns red if the committed files and the catalog drift.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentRoleIds, getAgentCatalogEntry } from "../src/archon/agent-catalog.ts";
import {
  renderAgentFrontmatter,
  replaceFrontmatterBlock
} from "../src/archon/agent-frontmatter.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const drifted: string[] = [];
  let written = 0;

  for (const role of agentRoleIds) {
    const entry = getAgentCatalogEntry(role);
    if (!entry.shipsAgentArtifact) {
      continue;
    }
    const filePath = path.join(repoRoot, entry.artifactPath);
    const current = await readFile(filePath, "utf8");
    const next = replaceFrontmatterBlock(current, renderAgentFrontmatter(role));
    if (next === current) {
      continue;
    }
    if (check) {
      drifted.push(entry.artifactPath);
    } else {
      await writeFile(filePath, next, "utf8");
      written += 1;
      process.stdout.write(`regenerated ${entry.artifactPath}\n`);
    }
  }

  if (check) {
    if (drifted.length > 0) {
      process.stderr.write(
        `frontmatter drift: ${drifted.length} AGENT.md file(s) do not match the catalog:\n` +
          drifted.map((p) => `  - ${p}`).join("\n") +
          `\nRun: node --experimental-strip-types scripts/generate-agent-frontmatter.ts\n`
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write("frontmatter in sync with catalog (no drift)\n");
    return;
  }

  process.stdout.write(
    written === 0 ? "frontmatter already in sync (nothing to write)\n" : `regenerated ${written} file(s)\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
