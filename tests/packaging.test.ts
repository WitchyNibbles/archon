/**
 * packaging.test.ts
 *
 * P1 (installHardeningP1Packaging): asserts package.json publishing invariants
 * and that merge.ts produces no unscoped node_modules/archon/ paths in its
 * generated consumer scripts.
 *
 * These tests run in the unit-tests CI job (npm ci → npm run build → check:coverage)
 * without requiring a built dist/. They are purely static checks on source files.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergePackageJson, archonMcpConfigFragment, grafanaMcpConfigFragment } from "../src/install/merge.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// package.json invariants
// ---------------------------------------------------------------------------

test("package.json: name is the scoped @witchynibbles/archon package", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
    name?: string;
  };
  assert.equal(pkg.name, "@witchynibbles/archon", "package.json name must be @witchynibbles/archon");
});

test("package.json: private is not set (publishable)", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
    private?: boolean;
  };
  assert.ok(
    pkg.private !== true,
    "package.json must not have private:true — the package must be publishable"
  );
});

test("package.json: main field points into dist/", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
    main?: string;
  };
  assert.ok(pkg.main, "package.json must have a main field");
  assert.match(pkg.main, /^dist\//, "package.json main must reference a dist/ path");
});

test("package.json: exports field is present with '.' entry", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
    exports?: Record<string, unknown>;
  };
  assert.ok(pkg.exports, "package.json must have an exports field");
  assert.ok(
    typeof pkg.exports["."] === "object" && pkg.exports["."] !== null,
    "package.json exports must include a '.' entry"
  );
  assert.ok(
    pkg.exports["./package.json"],
    "package.json exports must include './package.json'"
  );
});

test("package.json: types field points into dist/", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
    types?: string;
  };
  assert.ok(pkg.types, "package.json must have a types field");
  assert.match(pkg.types, /^dist\/.*\.d\.ts$/, "package.json types must reference a dist/*.d.ts path");
});

test("package.json: prepublishOnly script is present (guards against stale dist on publish)", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  assert.ok(
    typeof pkg.scripts?.prepublishOnly === "string" && pkg.scripts.prepublishOnly.length > 0,
    "package.json must have a prepublishOnly script to prevent publishing a stale or empty dist"
  );
});

test("package.json: files[] does not include any src/*.ts entries", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
    files?: string[];
  };
  assert.ok(Array.isArray(pkg.files), "package.json must have a files[] array");
  const srcTsEntries = pkg.files.filter((f) => f.startsWith("src/") && f.endsWith(".ts"));
  assert.deepEqual(
    srcTsEntries,
    [],
    `package.json files[] must not include raw TypeScript source entries: found ${JSON.stringify(srcTsEntries)}`
  );
});

test("package.json: files[] does not include src/ directory globs", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
    files?: string[];
  };
  assert.ok(Array.isArray(pkg.files), "package.json must have a files[] array");
  const srcDirEntries = pkg.files.filter((f) => f.startsWith("src/") && !f.includes("*"));
  assert.deepEqual(
    srcDirEntries,
    [],
    `package.json files[] must not include src/ directory entries: found ${JSON.stringify(srcDirEntries)}`
  );
});

// ---------------------------------------------------------------------------
// merge.ts: no unscoped node_modules/archon/ paths in generated output
//
// mergePackageJson() writes consumer npm scripts. The scoped package installs
// to node_modules/@witchynibbles/archon/ — any remaining node_modules/archon/
// (without scope) reference would silently break consumer installs.
// ---------------------------------------------------------------------------

const UNSCOPED_PKG_PATH = "@witchynibbles".slice(0, 0) + "node_modules" + "/" + "archon" + "/";

test("mergePackageJson(): generated consumer package.json contains no unscoped archon path", () => {
  const output = mergePackageJson(undefined, "./node_modules/@witchynibbles/archon");
  assert.doesNotMatch(
    output,
    new RegExp(UNSCOPED_PKG_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "mergePackageJson() must not produce unscoped node_modules/archon/ paths in consumer scripts"
  );
});

test("mergePackageJson(): generated consumer package.json contains no unscoped archon path (with-grafana)", () => {
  const output = mergePackageJson(undefined, "./node_modules/@witchynibbles/archon", { withGrafana: true });
  assert.doesNotMatch(
    output,
    new RegExp(UNSCOPED_PKG_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "mergePackageJson() with --with-grafana must not produce unscoped node_modules/archon/ paths"
  );
});

test("mergePackageJson(): devDependencies key is @witchynibbles/archon (scoped)", () => {
  const output = JSON.parse(mergePackageJson(undefined, "./node_modules/@witchynibbles/archon")) as {
    devDependencies?: Record<string, string>;
  };
  assert.ok(
    typeof output.devDependencies?.["@witchynibbles/archon"] === "string",
    "mergePackageJson() must write devDependencies[\"@witchynibbles/archon\"] (scoped key)"
  );
  assert.ok(
    output.devDependencies?.["archon"] === undefined,
    "mergePackageJson() must not write the old unscoped devDependencies[\"archon\"] key"
  );
});

test("archonMcpConfigFragment(): uses scoped @witchynibbles/archon install path", () => {
  const config = JSON.parse(archonMcpConfigFragment()) as {
    mcpServers?: { archon?: { args?: string[] } };
  };
  const args = config.mcpServers?.archon?.args ?? [];
  const binArg = args[0] ?? "";
  assert.match(
    binArg,
    /@witchynibbles\/archon/,
    "archonMcpConfigFragment() bin arg must reference the scoped package path"
  );
  assert.doesNotMatch(
    binArg,
    new RegExp(UNSCOPED_PKG_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "archonMcpConfigFragment() must not reference the unscoped node_modules/archon/ path"
  );
});

test("grafanaMcpConfigFragment(): uses scoped @witchynibbles/archon install path", () => {
  const config = JSON.parse(grafanaMcpConfigFragment()) as {
    mcpServers?: { grafana?: { args?: string[] } };
  };
  const args = config.mcpServers?.grafana?.args ?? [];
  const serverArg = args[0] ?? "";
  assert.match(
    serverArg,
    /@witchynibbles\/archon/,
    "grafanaMcpConfigFragment() server arg must reference the scoped package path"
  );
  assert.doesNotMatch(
    serverArg,
    new RegExp(UNSCOPED_PKG_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "grafanaMcpConfigFragment() must not reference the unscoped node_modules/archon/ path"
  );
});

test("package.json: bin field maps archon to dist/cli/archon-bin.js", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
    bin?: Record<string, string>;
  };
  assert.ok(pkg.bin, "package.json must have a bin field");
  assert.equal(
    pkg.bin["archon"],
    "dist/cli/archon-bin.js",
    "package.json bin.archon must point to dist/cli/archon-bin.js — changing this breaks the installed archon command"
  );
});
