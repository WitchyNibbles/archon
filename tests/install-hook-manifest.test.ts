/**
 * Parity test: every .mjs hook referenced in .claude/settings.json must be in the install manifest.
 *
 * This test prevents recurrence of the bug where buildManifest used a hardcoded
 * hookMjsFiles list that omitted 4 of the 11 hook files, causing consumer repos to get
 * a settings.json that referenced hook files that were never installed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInstallManifest } from "../src/install/cli.ts";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Extract every .claude/hooks/*.mjs path referenced in settings.json
 * from hooks[].hooks[].command AND statusLine.command.
 */
function extractHookMjsReferences(settings: unknown): string[] {
  const results: string[] = [];

  if (!settings || typeof settings !== "object") {
    return results;
  }

  const s = settings as Record<string, unknown>;

  // statusLine.command
  if (s["statusLine"] && typeof s["statusLine"] === "object") {
    const statusLine = s["statusLine"] as Record<string, unknown>;
    if (typeof statusLine["command"] === "string") {
      const cmd = statusLine["command"];
      const match = cmd.match(/\.claude\/hooks\/(\S+\.mjs)/);
      if (match) {
        results.push(`.claude/hooks/${match[1]}`);
      }
    }
  }

  // hooks.<EventName>[].hooks[].command
  if (s["hooks"] && typeof s["hooks"] === "object") {
    const hooks = s["hooks"] as Record<string, unknown>;
    for (const eventHandlers of Object.values(hooks)) {
      if (!Array.isArray(eventHandlers)) continue;
      for (const group of eventHandlers) {
        if (!group || typeof group !== "object") continue;
        const g = group as Record<string, unknown>;
        if (!Array.isArray(g["hooks"])) continue;
        for (const hookEntry of g["hooks"]) {
          if (!hookEntry || typeof hookEntry !== "object") continue;
          const h = hookEntry as Record<string, unknown>;
          if (typeof h["command"] === "string") {
            const match = h["command"].match(/\.claude\/hooks\/(\S+\.mjs)/);
            if (match) {
              results.push(`.claude/hooks/${match[1]}`);
            }
          }
        }
      }
    }
  }

  // Deduplicate and sort for stable assertions.
  return [...new Set(results)].sort();
}

test("settings.json hook .mjs references all appear in the install manifest (parity invariant)", async () => {
  // 1. Parse settings.json and extract all .claude/hooks/*.mjs references.
  const settingsContent = await readFile(path.join(sourceRoot, ".claude/settings.json"), "utf8");
  const settings = JSON.parse(settingsContent) as unknown;
  const referencedHooks = extractHookMjsReferences(settings);

  assert.ok(
    referencedHooks.length > 0,
    "Expected at least one .claude/hooks/*.mjs reference in settings.json"
  );

  // 2. Build the install manifest.
  const manifest = await buildInstallManifest(sourceRoot);
  const manifestTargets = new Set(manifest.map((f) => f.target));

  // 3. Assert every referenced hook is present in the manifest.
  const missing = referencedHooks.filter((hook) => !manifestTargets.has(hook));

  assert.deepEqual(
    missing,
    [],
    `The following hooks are referenced in .claude/settings.json but missing from the install manifest:\n` +
      missing.map((h) => `  - ${h}`).join("\n") +
      `\n\nAll manifest targets with '.claude/hooks':\n` +
      [...manifestTargets].filter((t) => t.includes(".claude/hooks")).sort().map((t) => `  - ${t}`).join("\n")
  );
});

test("install manifest includes all .claude/hooks/*.mjs files present in source", async () => {
  // Assert the reverse direction: every *.mjs file in source .claude/hooks/
  // is represented in the manifest. This catches future regressions
  // if someone adds a hook file but forgets to update the install code.
  const hooksDir = path.join(sourceRoot, ".claude/hooks");
  const sourceMjsFiles = (await readdir(hooksDir))
    .filter((f) => f.endsWith(".mjs"))
    .sort()
    .map((f) => `.claude/hooks/${f}`);

  assert.ok(sourceMjsFiles.length > 0, "Expected at least one .mjs file in source .claude/hooks/");

  const manifest = await buildInstallManifest(sourceRoot);
  const manifestTargets = new Set(manifest.map((f) => f.target));

  const notInManifest = sourceMjsFiles.filter((f) => !manifestTargets.has(f));

  assert.deepEqual(
    notInManifest,
    [],
    `The following .mjs files exist in source .claude/hooks/ but are not in the install manifest:\n` +
      notInManifest.map((h) => `  - ${h}`).join("\n")
  );
});

test("install manifest hook .mjs targets are sorted deterministically", async () => {
  const manifest = await buildInstallManifest(sourceRoot);
  const hookTargets = manifest
    .map((f) => f.target)
    .filter((t) => t.startsWith(".claude/hooks/") && t.endsWith(".mjs"));

  const sorted = [...hookTargets].sort();
  assert.deepEqual(hookTargets, sorted, "Hook .mjs targets in manifest should appear in sorted order");
});
