import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type {
  CoverageCriticality,
  CoverageGapRecord,
  CoverageItemCategory,
  CoverageItemRecord,
  UnderstandingMapKind,
  UnderstandingMapRecord
} from "../domain/types.ts";

const DEFAULT_CODE_INCLUDE_PATHS = ["src", "scripts", "tests", "package.json", "tsconfig.json"] as const;
const DEFAULT_EXCLUDED_SEGMENTS = new Set([".git", "node_modules", "dist", "build", "coverage"]);

export interface GenerateRepoInventoryInput {
  repoRoot: string;
  now?: string | undefined;
  include?: readonly string[] | undefined;
}

export interface RepoInventoryResult {
  coverageItems: CoverageItemRecord[];
  understandingMaps: UnderstandingMapRecord[];
  gaps: CoverageGapRecord[];
}

interface RepoDependencyEdge {
  from: string;
  to: string;
  via?: string | undefined;
  kind: "import" | "call";
}

interface RepoCartography {
  dependencyEdges: RepoDependencyEdge[];
  callEdges: RepoDependencyEdge[];
  exportedSymbols: Array<{
    file: string;
    name: string;
  }>;
  domainContexts: Array<{
    name: string;
    files: string[];
  }>;
  dependenciesByFile: Map<string, string[]>;
  dependentsByFile: Map<string, string[]>;
}

interface RepoCodeFile {
  relativePath: string;
  content: string;
}

interface SurfaceSignal {
  key: string;
  category: CoverageItemCategory;
  mapKind?: UnderstandingMapKind | undefined;
  method: string;
  summary: string;
  confidence: number;
  sideEffects?: string[] | undefined;
}

interface AmbiguitySignal {
  method: string;
  description: string;
}

export async function generateRepoInventory(input: GenerateRepoInventoryInput): Promise<RepoInventoryResult> {
  const repoRoot = await realpath(input.repoRoot);
  const include = input.include && input.include.length > 0 ? input.include : DEFAULT_CODE_INCLUDE_PATHS;
  const now = input.now ?? new Date().toISOString();
  const files = await collectCodeFiles(repoRoot, include);
  const cartography = buildRepoCartography(files);

  const fileCoverageItems = files.map((file) => buildFileCoverageItem(file, now, cartography));
  const discoveredSignals = files.flatMap((file) => buildSignalCoverageItems(file, now));
  const coverageItems = dedupeCoverageItems([...fileCoverageItems, ...discoveredSignals]);
  const understandingMaps = buildUnderstandingMaps(files, discoveredSignals, cartography, now);
  const gaps = dedupeCoverageGaps(files.flatMap((file) => buildAmbiguityGaps(file)));

  return {
    coverageItems,
    understandingMaps,
    gaps
  };
}

async function collectCodeFiles(repoRoot: string, includePaths: readonly string[]): Promise<RepoCodeFile[]> {
  const results = new Map<string, RepoCodeFile>();

  for (const includePath of includePaths) {
    const absolutePath = path.resolve(repoRoot, includePath);
    const kind = await safeStatKind(absolutePath);
    if (!kind) {
      continue;
    }

    if (kind === "file") {
      const relativePath = normalizeRelativePath(repoRoot, absolutePath);
      if (isAllowedCodeFile(relativePath)) {
        results.set(relativePath, {
          relativePath,
          content: await safeReadText(absolutePath)
        });
      }
      continue;
    }

    for (const file of await walkCodeFiles(repoRoot, absolutePath)) {
      results.set(file.relativePath, file);
    }
  }

  return [...results.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function walkCodeFiles(repoRoot: string, directory: string): Promise<RepoCodeFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const results: RepoCodeFile[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = normalizeRelativePath(repoRoot, absolutePath);
    const segments = relativePath.split("/");
    if (segments.some((segment) => DEFAULT_EXCLUDED_SEGMENTS.has(segment))) {
      continue;
    }

    if (entry.isDirectory()) {
      results.push(...(await walkCodeFiles(repoRoot, absolutePath)));
      continue;
    }

    if ((entry.isFile() || entry.isSymbolicLink()) && isAllowedCodeFile(relativePath)) {
      results.push({
        relativePath,
        content: await safeReadText(absolutePath)
      });
    }
  }

  return results;
}

function isAllowedCodeFile(relativePath: string): boolean {
  return (
    relativePath.endsWith(".ts") ||
    relativePath.endsWith(".tsx") ||
    relativePath.endsWith(".js") ||
    relativePath.endsWith(".mjs") ||
    relativePath.endsWith(".cjs") ||
    relativePath.endsWith(".sh") ||
    relativePath === "package.json" ||
    relativePath === "tsconfig.json"
  );
}

function buildFileCoverageItem(file: RepoCodeFile, now: string, cartography: RepoCartography): CoverageItemRecord {
  const ambiguities = detectAmbiguitySignals(file);
  const dependencies = cartography.dependenciesByFile.get(file.relativePath);
  const dependents = cartography.dependentsByFile.get(file.relativePath);
  const cartographyRefs = [
    ...(dependencies ?? []).map((dependency) => `dependency://${file.relativePath}->${dependency}`),
    ...(dependents ?? []).map((dependent) => `dependent://${dependent}->${file.relativePath}`)
  ];
  return {
    id: `file:${file.relativePath}`,
    category: inferCoverageCategory(file.relativePath),
    state: inferCoverageState(file.relativePath),
    criticality: inferCriticality(file.relativePath),
    sources: [file.relativePath],
    dependencies,
    dependents,
    evidenceRefs: [
      file.relativePath,
      ...cartographyRefs,
      ...ambiguities.map((ambiguity) => `ambiguity://${ambiguity.method}`)
    ],
    openQuestions:
      ambiguities.length > 0
        ? ambiguities.map((ambiguity) => ambiguity.description)
        : undefined,
    lastUpdatedAt: now
  };
}

function inferCoverageCategory(relativePath: string): CoverageItemCategory {
  if (relativePath.startsWith("tests/")) {
    return "tests";
  }
  if (relativePath === "package.json" || relativePath === "tsconfig.json") {
    return "configuration";
  }
  if (relativePath.startsWith("scripts/")) {
    return "runtime_side_effects";
  }
  if (relativePath.startsWith("src/domain/")) {
    return "models";
  }
  if (relativePath.startsWith("src/install/")) {
    return "configuration";
  }
  if (relativePath.startsWith("src/mcp/") || relativePath.startsWith("src/store/")) {
    return "external_integrations";
  }
  if (relativePath.startsWith("src/runtime/") || relativePath.startsWith("src/core/")) {
    return "services";
  }
  return "services";
}

function inferCoverageState(relativePath: string): CoverageItemRecord["state"] {
  if (relativePath.startsWith("tests/")) {
    return "fully_analyzed";
  }
  if (relativePath.startsWith("src/domain/") || relativePath === "package.json" || relativePath === "tsconfig.json") {
    return "fully_analyzed";
  }
  return "discovered";
}

function inferCriticality(relativePath: string): CoverageCriticality {
  if (
    relativePath === "src/core/service.ts" ||
    relativePath === "src/runtime/autonomous-execution.ts" ||
    relativePath === "scripts/check-devgod-workflow.sh"
  ) {
    return "critical";
  }
  if (
    relativePath.startsWith("src/core/") ||
    relativePath.startsWith("src/runtime/") ||
    relativePath.startsWith("src/admin/")
  ) {
    return "high";
  }
  if (relativePath.startsWith("tests/") || relativePath.startsWith("src/domain/")) {
    return "medium";
  }
  return "low";
}

function buildSignalCoverageItems(file: RepoCodeFile, now: string): CoverageItemRecord[] {
  const ambiguities = detectAmbiguitySignals(file);
  const signals = detectSurfaceSignals(file);
  return signals.map((signal) => {
    const evidenceRefs = uniqueStrings([
      file.relativePath,
      `signal://${signal.method}`,
      ...ambiguities.map((ambiguity) => `ambiguity://${ambiguity.method}`)
    ]);
    const openQuestions = ambiguities.map((ambiguity) => ambiguity.description);
    const summary =
      ambiguities.length > 0
        ? `${signal.summary}; follow-up required for ${ambiguities.map((ambiguity) => ambiguity.method).join(", ")}`
        : signal.summary;

    return {
      id: `${signal.key}:${file.relativePath}`,
      category: signal.category,
      state: ambiguities.length > 0 ? "partially_analyzed" : "fully_analyzed",
      criticality: inferCriticality(file.relativePath),
      sources: [file.relativePath],
      entryPoints: signal.category === "routes" || signal.category === "runtime_side_effects" ? [file.relativePath] : undefined,
      behaviorSummary: summary,
      sideEffects: signal.sideEffects,
      openQuestions: openQuestions.length > 0 ? openQuestions : undefined,
      evidenceRefs,
      confidence: signal.confidence,
      lastUpdatedAt: now
    };
  });
}

function detectSurfaceSignals(file: RepoCodeFile): SurfaceSignal[] {
  const relativePath = file.relativePath;
  const content = file.content;
  const signals: SurfaceSignal[] = [];

  const addSignal = (signal: SurfaceSignal, predicate: boolean) => {
    if (!predicate || signals.some((existing) => existing.key === signal.key)) {
      return;
    }
    signals.push(signal);
  };

  addSignal(
    {
      key: "route",
      category: "routes",
      mapKind: "route_map",
      method: relativePath.startsWith("src/admin/") ? "path:src-admin" : "content:command-dispatch",
      summary: "generated route surface from command or router entrypoint signals",
      confidence: relativePath.startsWith("src/admin/") ? 0.82 : 0.74
    },
    relativePath.startsWith("src/admin/") || /\bif\s*\(\s*command\s*===|\bswitch\s*\(\s*command\s*\)|\b(?:router|app)\.(?:get|post|put|delete|patch|use)\s*\(/.test(content)
  );

  addSignal(
    {
      key: "service",
      category: "services",
      method: relativePath.startsWith("src/core/") || relativePath.startsWith("src/runtime/") ? "path:core-runtime" : "content:service-symbol",
      summary: "generated service surface from core/runtime ownership or service-like exported symbols",
      confidence: relativePath.startsWith("src/core/") || relativePath.startsWith("src/runtime/") ? 0.86 : 0.68
    },
    relativePath.startsWith("src/core/") ||
      relativePath.startsWith("src/runtime/") ||
      /\bclass\s+\w+Service\b|\b(?:export\s+)?(?:async\s+)?function\s+\w+Service\b/.test(content)
  );

  addSignal(
    {
      key: "integration",
      category: "external_integrations",
      mapKind: "integration_map",
      method: relativePath.startsWith("src/mcp/") || relativePath.startsWith("src/store/") || relativePath.startsWith("src/install/") ? "path:integration-surface" : "content:external-io",
      summary: "generated external integration surface from MCP, store, install, or outbound I/O signals",
      confidence: relativePath.startsWith("src/mcp/") || relativePath.startsWith("src/store/") || relativePath.startsWith("src/install/") ? 0.83 : 0.7
    },
    relativePath.startsWith("src/mcp/") ||
      relativePath.startsWith("src/store/") ||
      relativePath.startsWith("src/install/") ||
      /\bfetch\s*\(|from\s+["']pg["']|from\s+["']openai["']/.test(content)
  );

  addSignal(
    {
      key: "configuration",
      category: "configuration",
      mapKind: "config_coupling",
      method:
        relativePath === "package.json" || relativePath === "tsconfig.json"
          ? "path:manifest-file"
          : "content:configuration-coupling",
      summary: "generated configuration surface from manifest files or environment/config coupling",
      confidence:
        relativePath === "package.json" || relativePath === "tsconfig.json" ? 0.92 : 0.72
    },
    relativePath === "package.json" ||
      relativePath === "tsconfig.json" ||
      /process\.env\.[A-Z0-9_]+|\bconfig\b|\benv\b/i.test(content) ||
      relativePath.includes("config")
  );

  addSignal(
    {
      key: "authentication",
      category: "authentication",
      mapKind: "authz_map",
      method: "content:authentication-keywords",
      summary: "generated authentication surface from principal, token, credential, or login signals",
      confidence: 0.66
    },
    /\bauthentication\b|\blogin\b|\bprincipal\b|\bcredential\b|\btoken\b/i.test(content)
  );

  addSignal(
    {
      key: "authorization",
      category: "authorization",
      mapKind: "authz_map",
      method: "content:authorization-keywords",
      summary: "generated authorization surface from policy, permission, waiver, or review-identity signals",
      confidence: 0.72
    },
    /\bauthoriz|\bpermission\b|\bpolicy\b|review[-_ ]identity|\bwaiver\b/i.test(content)
  );

  addSignal(
    {
      key: "runtime-side-effects",
      category: "runtime_side_effects",
      mapKind: "runtime_side_effects",
      method:
        relativePath.startsWith("scripts/") || relativePath.startsWith("src/runtime/")
          ? "path:runtime-side-effects"
          : "content:filesystem-or-process-io",
      summary: "generated runtime-side-effect surface from script ownership or filesystem/process I/O signals",
      confidence:
        relativePath.startsWith("scripts/") || relativePath.startsWith("src/runtime/") ? 0.85 : 0.69,
      sideEffects: inferSideEffects(content)
    },
    relativePath.startsWith("scripts/") ||
      relativePath.startsWith("src/runtime/") ||
      relativePath === "src/core/service.ts" ||
      /\b(?:writeFile|mkdir|rm|spawn|exec|saveProjectRuntimeState|saveRunArtifact)\b/.test(content)
  );

  return signals;
}

function inferSideEffects(content: string): string[] | undefined {
  const effects: string[] = [];
  if (/\bwriteFile\b/.test(content)) {
    effects.push("writes files");
  }
  if (/\bmkdir\b/.test(content) || /\brm\b/.test(content)) {
    effects.push("changes filesystem layout");
  }
  if (/\bspawn\b|\bexec\b/.test(content)) {
    effects.push("executes subprocesses");
  }
  if (/\bsaveProjectRuntimeState\b|\bsaveRunArtifact\b/.test(content)) {
    effects.push("persists runtime state");
  }
  return effects.length > 0 ? effects : undefined;
}

function buildUnderstandingMaps(
  files: readonly RepoCodeFile[],
  signalItems: readonly CoverageItemRecord[],
  cartography: RepoCartography,
  now: string
): UnderstandingMapRecord[] {
  const relativePaths = files.map((file) => file.relativePath);
  const topLevelSubsystems = new Set<string>();
  for (const relativePath of relativePaths) {
    const srcMatch = relativePath.match(/^src\/([^/]+)\//);
    if (srcMatch?.[1]) {
      topLevelSubsystems.add(srcMatch[1]);
    }
  }

  const routeFiles = signalSourceRefs(signalItems, ["routes"], ["src/admin/"]);
  const modelFiles = relativePaths.filter((relativePath) => relativePath.startsWith("src/domain/"));
  const integrationFiles = signalSourceRefs(signalItems, ["external_integrations"], ["src/mcp/", "src/store/", "src/install/"]);
  const authzFiles = signalSourceRefs(signalItems, ["authentication", "authorization", "permissions"]);
  const configFiles = signalSourceRefs(signalItems, ["configuration"], ["package.json", "tsconfig.json"]);
  const runtimeSideEffectFiles = signalSourceRefs(signalItems, ["runtime_side_effects"], ["scripts/", "src/runtime/", "src/core/service.ts"]);
  const domainRefs = cartography.domainContexts.map((context) => `domain:${context.name}`);
  const symbolRefs = cartography.exportedSymbols.map((symbol) => `symbol:${symbol.file}#${symbol.name}`);
  const callRefs = cartography.callEdges.map((edge) => `call:${edge.from}->${edge.to}${edge.via ? `#${edge.via}` : ""}`);
  const dependencyRefs = cartography.dependencyEdges.map((edge) => `dependency:${edge.from}->${edge.to}`);

  return [
    buildUnderstandingMap("repo_map", relativePaths, [relativePaths[0] ?? "repo://none"], now),
    buildUnderstandingMap("subsystems", [...topLevelSubsystems], [...topLevelSubsystems], now),
    buildUnderstandingMap("route_map", routeFiles, evidenceRefsForSources(signalItems, routeFiles), now),
    buildUnderstandingMap("model_map", modelFiles, modelFiles, now),
    buildUnderstandingMap("integration_map", integrationFiles, evidenceRefsForSources(signalItems, integrationFiles), now),
    buildUnderstandingMap("authz_map", authzFiles, evidenceRefsForSources(signalItems, authzFiles), now),
    buildUnderstandingMap("config_coupling", configFiles, evidenceRefsForSources(signalItems, configFiles), now),
    buildUnderstandingMap(
      "runtime_side_effects",
      runtimeSideEffectFiles,
      evidenceRefsForSources(signalItems, runtimeSideEffectFiles),
      now
    ),
    buildUnderstandingMap("domain_map", domainRefs, evidenceRefsForCartography(domainRefs, cartography, relativePaths), now),
    buildUnderstandingMap(
      "symbol_graph",
      symbolRefs,
      evidenceRefsForCartography(symbolRefs, cartography, relativePaths),
      now
    ),
    buildUnderstandingMap(
      "call_graph",
      callRefs,
      evidenceRefsForCartography(callRefs, cartography, relativePaths),
      now
    ),
    buildUnderstandingMap(
      "dependency_graph",
      dependencyRefs,
      evidenceRefsForCartography(dependencyRefs, cartography, relativePaths),
      now
    )
  ];
}

function evidenceRefsForCartography(
  sourceRefs: readonly string[],
  cartography: RepoCartography,
  fallbackRefs: readonly string[]
): string[] {
  if (sourceRefs.length === 0) {
    return uniqueStrings(fallbackRefs.slice(0, 10));
  }

  const supportingFiles = uniqueStrings([
    ...cartography.domainContexts.flatMap((context) => context.files),
    ...cartography.exportedSymbols.map((symbol) => symbol.file),
    ...cartography.callEdges.flatMap((edge) => [edge.from, edge.to]),
    ...cartography.dependencyEdges.flatMap((edge) => [edge.from, edge.to])
  ]);
  return uniqueStrings([...sourceRefs.slice(0, 10), ...supportingFiles.slice(0, 10)]);
}

function signalSourceRefs(
  signalItems: readonly CoverageItemRecord[],
  categories: readonly CoverageItemCategory[],
  pathPrefixes: readonly string[] = []
): string[] {
  const sources = signalItems
    .filter((item) => categories.includes(item.category))
    .flatMap((item) => item.sources);
  for (const prefix of pathPrefixes) {
    if (prefix.includes(".")) {
      sources.push(prefix);
    }
  }
  return uniqueStrings(sources);
}

function evidenceRefsForSources(signalItems: readonly CoverageItemRecord[], sourceRefs: readonly string[]): string[] {
  const refs = signalItems
    .filter((item) => item.sources.some((source) => sourceRefs.includes(source)))
    .flatMap((item) => item.evidenceRefs);
  return uniqueStrings(refs.length > 0 ? refs : [...sourceRefs]);
}

function buildUnderstandingMap(
  kind: UnderstandingMapKind,
  sourceRefs: readonly string[],
  evidenceRefs: readonly string[],
  now: string
): UnderstandingMapRecord {
  const normalizedSourceRefs = sourceRefs.length > 0 ? uniqueStrings(sourceRefs) : ["repo://none"];
  const normalizedEvidenceRefs = evidenceRefs.length > 0 ? uniqueStrings(evidenceRefs).slice(0, 10) : [normalizedSourceRefs[0] ?? "repo://none"];
  return {
    kind,
    itemCount: sourceRefs.length,
    analyzedCount: sourceRefs.length,
    sourceRefs: normalizedSourceRefs,
    evidenceRefs: normalizedEvidenceRefs,
    updatedAt: now
  };
}

function buildAmbiguityGaps(file: RepoCodeFile): CoverageGapRecord[] {
  if (file.relativePath.startsWith("tests/")) {
    return [];
  }

  const ambiguities = detectAmbiguitySignals(file);
  if (ambiguities.length === 0) {
    return [];
  }

  const blocking = ["high", "critical"].includes(inferCriticality(file.relativePath));
  return [
    {
      id: `gap:inventory:${slugify(file.relativePath)}:dynamic-discovery`,
      targetId: `file:${file.relativePath}`,
      kind: "missing_inventory",
      severity: blocking ? "high" : "medium",
      description: `dynamic discovery signals in ${file.relativePath} require manual follow-up before the surface can be treated as fully understood`,
      blocking,
      evidenceRefs: [
        file.relativePath,
        ...ambiguities.map((ambiguity) => `ambiguity://${ambiguity.method}`)
      ],
      createdBy: "repo_inventory",
      suggestedNextActions: ambiguities.map(
        (ambiguity) => `inspect ${file.relativePath} for ${ambiguity.method} and record the concrete route, auth, or config surface explicitly`
      ),
      status: "open"
    }
  ];
}

function detectAmbiguitySignals(file: RepoCodeFile): AmbiguitySignal[] {
  const content = file.content;
  const ambiguities: AmbiguitySignal[] = [];
  if (/\b(?:handlers?|commands?|routes?)\s*\[[^\]]+\]/.test(content)) {
    ambiguities.push({
      method: "computed-dispatch-table",
      description: "computed dispatch table hides the concrete handler surface from static inventory heuristics"
    });
  }
  if (/\b(?:router|app)\s*\[[^\]]+\]\s*\(/.test(content)) {
    ambiguities.push({
      method: "computed-route-method",
      description: "computed route method prevents deterministic route classification"
    });
  }
  if (/process\.env\[[^\]]+\]/.test(content)) {
    ambiguities.push({
      method: "computed-env-key",
      description: "computed environment keys hide configuration coupling that should be reviewed explicitly"
    });
  }
  return ambiguities;
}

function dedupeCoverageItems(items: readonly CoverageItemRecord[]): CoverageItemRecord[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function dedupeCoverageGaps(gaps: readonly CoverageGapRecord[]): CoverageGapRecord[] {
  const byId = new Map(gaps.map((gap) => [gap.id, gap]));
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function buildRepoCartography(files: readonly RepoCodeFile[]): RepoCartography {
  const fileSet = new Set(files.map((file) => file.relativePath));
  const dependencyEdges: RepoDependencyEdge[] = [];
  const callEdges: RepoDependencyEdge[] = [];
  const exportedSymbols: RepoCartography["exportedSymbols"] = [];
  const domainContexts = new Map<string, string[]>();
  const dependenciesByFile = new Map<string, string[]>();
  const dependentsByFile = new Map<string, string[]>();

  for (const file of files) {
    const srcMatch = file.relativePath.match(/^src\/([^/]+)\//);
    if (srcMatch?.[1]) {
      const existing = domainContexts.get(srcMatch[1]) ?? [];
      existing.push(file.relativePath);
      domainContexts.set(srcMatch[1], existing);
    }

    const imports = parseRelativeImports(file, fileSet);
    for (const importRecord of imports) {
      dependencyEdges.push({
        from: file.relativePath,
        to: importRecord.target,
        kind: "import"
      });
      addMapValue(dependenciesByFile, file.relativePath, importRecord.target);
      addMapValue(dependentsByFile, importRecord.target, file.relativePath);

      for (const binding of importRecord.bindings) {
        if (new RegExp(`\\b(?:new\\s+)?${escapeForRegex(binding)}\\s*\\(`).test(file.content)) {
          callEdges.push({
            from: file.relativePath,
            to: importRecord.target,
            via: binding,
            kind: "call"
          });
        }
      }
    }

    for (const symbol of parseExportedSymbols(file.content)) {
      exportedSymbols.push({
        file: file.relativePath,
        name: symbol
      });
    }
  }

  return {
    dependencyEdges: dedupeEdges(dependencyEdges),
    callEdges: dedupeEdges(callEdges),
    exportedSymbols: dedupeSymbols(exportedSymbols),
    domainContexts: [...domainContexts.entries()]
      .map(([name, contextFiles]) => ({
        name,
        files: [...new Set(contextFiles)].sort()
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    dependenciesByFile,
    dependentsByFile
  };
}

function parseRelativeImports(
  file: RepoCodeFile,
  fileSet: ReadonlySet<string>
): Array<{ target: string; bindings: string[] }> {
  const imports: Array<{ target: string; bindings: string[] }> = [];
  const importRegex =
    /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?([^;\n]*?)\s*from\s*["']([^"']+)["']/g;
  for (const match of file.content.matchAll(importRegex)) {
    const clause = match[1]?.trim() ?? "";
    const specifier = match[2]?.trim() ?? "";
    if (!specifier.startsWith(".")) {
      continue;
    }
    const target = resolveRelativeModule(file.relativePath, specifier, fileSet);
    if (!target) {
      continue;
    }
    imports.push({
      target,
      bindings: parseImportedBindings(clause)
    });
  }
  return imports;
}

function parseImportedBindings(clause: string): string[] {
  const bindings: string[] = [];
  const trimmed = clause.trim();
  if (trimmed.length === 0) {
    return bindings;
  }

  const namedMatch = trimmed.match(/\{([^}]+)\}/);
  if (namedMatch?.[1]) {
    for (const entry of namedMatch[1].split(",")) {
      const part = entry.trim();
      if (!part) {
        continue;
      }
      const aliasMatch = part.match(/\bas\s+([A-Za-z0-9_$]+)/);
      bindings.push(aliasMatch?.[1] ?? part.replace(/\bas\s+.*/, "").trim());
    }
  }

  const namespaceMatch = trimmed.match(/\*\s+as\s+([A-Za-z0-9_$]+)/);
  if (namespaceMatch?.[1]) {
    bindings.push(namespaceMatch[1]);
  }

  const leading = trimmed.split(",")[0]?.trim() ?? "";
  if (
    leading.length > 0 &&
    !leading.startsWith("{") &&
    !leading.startsWith("*") &&
    /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(leading)
  ) {
    bindings.push(leading);
  }

  return uniqueStrings(bindings);
}

function parseExportedSymbols(content: string): string[] {
  const symbols: string[] = [];
  const declarationRegex =
    /export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  for (const match of content.matchAll(declarationRegex)) {
    if (match[1]) {
      symbols.push(match[1]);
    }
  }

  const namedExportRegex = /export\s*\{([^}]+)\}/g;
  for (const match of content.matchAll(namedExportRegex)) {
    const block = match[1] ?? "";
    for (const entry of block.split(",")) {
      const part = entry.trim();
      if (!part) {
        continue;
      }
      const aliasMatch = part.match(/\bas\s+([A-Za-z0-9_$]+)/);
      symbols.push(aliasMatch?.[1] ?? part.replace(/\bas\s+.*/, "").trim());
    }
  }

  return uniqueStrings(symbols);
}

function resolveRelativeModule(
  fromRelativePath: string,
  specifier: string,
  fileSet: ReadonlySet<string>
): string | undefined {
  const fromDirectory = path.posix.dirname(fromRelativePath);
  const resolvedBase = path.posix.normalize(path.posix.join(fromDirectory, specifier));
  const candidates = [
    resolvedBase,
    `${resolvedBase}.ts`,
    `${resolvedBase}.tsx`,
    `${resolvedBase}.js`,
    `${resolvedBase}.mjs`,
    `${resolvedBase}.cjs`,
    path.posix.join(resolvedBase, "index.ts"),
    path.posix.join(resolvedBase, "index.tsx"),
    path.posix.join(resolvedBase, "index.js"),
    path.posix.join(resolvedBase, "index.mjs"),
    path.posix.join(resolvedBase, "index.cjs")
  ];
  return candidates.find((candidate) => fileSet.has(candidate));
}

function addMapValue(map: Map<string, string[]>, key: string, value: string): void {
  const existing = map.get(key) ?? [];
  existing.push(value);
  map.set(key, uniqueStrings(existing).sort());
}

function dedupeEdges(edges: readonly RepoDependencyEdge[]): RepoDependencyEdge[] {
  const byKey = new Map<string, RepoDependencyEdge>();
  for (const edge of edges) {
    byKey.set(`${edge.kind}:${edge.from}:${edge.to}:${edge.via ?? ""}`, edge);
  }
  return [...byKey.values()].sort(
    (left, right) =>
      left.from.localeCompare(right.from) ||
      left.to.localeCompare(right.to) ||
      (left.via ?? "").localeCompare(right.via ?? "")
  );
}

function dedupeSymbols(
  symbols: ReadonlyArray<{
    file: string;
    name: string;
  }>
): Array<{ file: string; name: string }> {
  const byKey = new Map<string, { file: string; name: string }>();
  for (const symbol of symbols) {
    byKey.set(`${symbol.file}:${symbol.name}`, symbol);
  }
  return [...byKey.values()].sort(
    (left, right) => left.file.localeCompare(right.file) || left.name.localeCompare(right.name)
  );
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function slugify(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

function normalizeRelativePath(repoRoot: string, targetPath: string): string {
  return path.relative(repoRoot, targetPath).split(path.sep).join("/");
}

async function safeReadText(targetPath: string): Promise<string> {
  try {
    return await readFile(targetPath, "utf8");
  } catch {
    return "";
  }
}

async function safeStatKind(targetPath: string): Promise<"file" | "directory" | null> {
  try {
    const resolved = await realpath(targetPath);
    const stats = await stat(resolved);
    if (stats.isFile()) {
      return "file";
    }
    if (stats.isDirectory()) {
      return "directory";
    }
    return null;
  } catch {
    return null;
  }
}
