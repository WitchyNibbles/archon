/**
 * @module forge/gen-dashboard-types
 *
 * Build-time code generator: emits TypeScript type declarations from the
 * DashboardViewModelSchema Zod contract in ./dashboard-contract.ts.
 *
 * Design notes:
 * - This module is the single source of truth for the generated web types.
 * - The emitter walks the concrete Zod schema shapes the contract actually uses;
 *   it NEVER emits `any` — it throws loudly on any unrecognised construct.
 * - No dependency on web/**: R2-C hard package boundary is preserved.
 * - The generated file has no zod import, so the web build does not need zod.
 *
 * CI ISOLATION NOTE:
 *   The web build (`cd web && npm ci && npm run build`) runs in an isolated step
 *   that does NOT have root node_modules (which provides zod for this emitter).
 *   CI MUST run codegen in a root-deps step FIRST:
 *     node --experimental-strip-types src/forge/gen-dashboard-types.ts \
 *       web/src/types/dashboard.generated.ts
 *   …and THEN run the isolated web build. See P1-S7/C8 for the CI wiring task.
 *
 * Usage (from repo root):
 *   node --experimental-strip-types src/forge/gen-dashboard-types.ts \
 *     web/src/types/dashboard.generated.ts
 */

import { writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DashboardViewModelSchema } from "./dashboard-contract.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// Schema-to-TypeScript emitter
// ---------------------------------------------------------------------------

/**
 * Convert a Zod schema rooted at the given ZodType into a TypeScript type
 * expression string.  This is the low-level recursive worker.
 *
 * Supported constructs (exactly the ones used in dashboard-contract.ts):
 *   z.string()          → string
 *   z.number()          → number
 *   z.boolean()         → boolean
 *   z.literal(value)    → typeof value literal (string/number/boolean)
 *   z.enum([...])       → union of string literals
 *   z.array(inner)      → inner[]
 *   .optional()         → inner | undefined
 *   .int(), .nonnegative() → decorators on ZodNumber (emit number, not any)
 *   z.object({...})     → inlined interface shape (recursive)
 *   z.union([...])      → A | B | ...
 *   z.discriminatedUnion → A | B | ...
 *
 * Any other construct raises an Error — NEVER silently falls back to `any`.
 */
export function zodTypeToTs(schema: z.ZodTypeAny, indent: number = 0): string {
  const pad = "  ".repeat(indent);

  // Unwrap ZodOptional: emit the inner type; the caller adds `?` on the property.
  if (schema instanceof z.ZodOptional) {
    return zodTypeToTs(schema.unwrap(), indent);
  }

  if (schema instanceof z.ZodString) {
    return "string";
  }

  if (schema instanceof z.ZodNumber) {
    return "number";
  }

  if (schema instanceof z.ZodBoolean) {
    return "boolean";
  }

  if (schema instanceof z.ZodLiteral) {
    const val: unknown = schema._def.value;
    if (typeof val === "string") return JSON.stringify(val);
    if (typeof val === "number" || typeof val === "boolean") return String(val);
    throw new Error(
      `gen-dashboard-types: unsupported ZodLiteral value type: ${typeof val}`
    );
  }

  if (schema instanceof z.ZodEnum) {
    const values: string[] = schema._def.values as string[];
    return values.map((v) => JSON.stringify(v)).join(" | ");
  }

  if (schema instanceof z.ZodArray) {
    const inner = zodTypeToTs(schema._def.type as z.ZodTypeAny, indent);
    // Wrap union/complex types in parens for readability.
    const needsParens = inner.includes("|") || inner.includes("{");
    return needsParens ? `(${inner})[]` : `${inner}[]`;
  }

  if (schema instanceof z.ZodObject) {
    const shape = schema._def.shape() as Record<string, z.ZodTypeAny>;
    const props = Object.entries(shape)
      .map(([key, val]) => {
        const isOptional = val instanceof z.ZodOptional;
        const innerTs = zodTypeToTs(val, indent + 1);
        const optMark = isOptional ? "?" : "";
        return `${pad}  ${key}${optMark}: ${innerTs};`;
      })
      .join("\n");
    return `{\n${props}\n${pad}}`;
  }

  if (schema instanceof z.ZodUnion) {
    const options = schema._def.options as z.ZodTypeAny[];
    return options.map((o) => zodTypeToTs(o, indent)).join(" | ");
  }

  if (schema instanceof z.ZodDiscriminatedUnion) {
    const options = schema._def.options as z.ZodTypeAny[];
    return options.map((o) => zodTypeToTs(o, indent)).join(" | ");
  }

  // Defensive: never emit `any` for unknown constructs.
  const typeName: string =
    (schema as { _def?: { typeName?: string } })._def?.typeName ?? "unknown";
  throw new Error(
    `gen-dashboard-types: unsupported Zod construct "${typeName}". ` +
      `Add explicit handling for it in zodTypeToTs() in src/forge/gen-dashboard-types.ts.`
  );
}

/**
 * Emit the full TypeScript file content for the DashboardViewModelSchema.
 *
 * Named exports:
 *   - One `type` alias per top-level ZodObject property name (PascalCase mapped
 *     from the exported schema constant names in dashboard-contract.ts).
 *   - Helper union types for discriminant arrays.
 *
 * Strategy: rather than generic introspection, we enumerate the concrete
 * top-level named types the contract publishes.  This is intentional — it
 * produces stable, readable output and fails loudly if the contract shape drifts
 * beyond what this emitter handles.
 */
export function emitTypes(schema: typeof DashboardViewModelSchema): string {
  // Collect the shape of the top-level DashboardViewModel object.
  const topShape = schema._def.shape() as Record<string, z.ZodTypeAny>;

  // Sub-schemas we need to emit as named types.  We extract them from the
  // top-level shape so names stay in sync automatically.
  const headerSchema = topShape["header"];
  const blockerSchema = (topShape["blockers"] as z.ZodArray<z.ZodTypeAny>)._def
    .type as z.ZodTypeAny;
  const taskQueueEntrySchema = (
    topShape["taskQueue"] as z.ZodArray<z.ZodTypeAny>
  )._def.type as z.ZodTypeAny;
  const reviewGateSchema = (
    topShape["reviewGates"] as z.ZodArray<z.ZodTypeAny>
  )._def.type as z.ZodTypeAny;
  const pulseSchema = topShape["pulse"];

  if (
    !headerSchema ||
    !blockerSchema ||
    !taskQueueEntrySchema ||
    !reviewGateSchema ||
    !pulseSchema
  ) {
    throw new Error(
      "gen-dashboard-types: expected top-level schema to contain " +
        "header, blockers, taskQueue, reviewGates, and pulse"
    );
  }

  // Derive helper union types from the enum schemas embedded in each object.
  function extractEnum(
    objSchema: z.ZodTypeAny,
    key: string
  ): string {
    const shape = (objSchema as z.ZodObject<z.ZodRawShape>)._def.shape() as Record<
      string,
      z.ZodTypeAny
    >;
    const field = shape[key];
    if (!field) {
      throw new Error(
        `gen-dashboard-types: expected field "${key}" on schema shape`
      );
    }
    // Unwrap optional if present.
    const inner = field instanceof z.ZodOptional ? field.unwrap() : field;
    return zodTypeToTs(inner, 0);
  }

  const runStatusType = extractEnum(headerSchema, "status");
  const authorityLabelType = extractEnum(headerSchema, "authorityLabel");
  const blockerKindType = extractEnum(blockerSchema, "kind");
  const taskStatusType = extractEnum(taskQueueEntrySchema, "status");
  const routingKindType = extractEnum(taskQueueEntrySchema, "routingRecommendation");
  const reviewStateType = extractEnum(reviewGateSchema, "state");
  const reviewSeverityType = extractEnum(reviewGateSchema, "severity");
  const gateRoleType = extractEnum(reviewGateSchema, "role");
  const pulseStateType = extractEnum(pulseSchema, "pulseState");

  const lines: string[] = [
    "// DO NOT EDIT — generated from src/forge/dashboard-contract.ts by src/forge/gen-dashboard-types.ts",
    "// CI NOTE: Run codegen in a root-deps step BEFORE the isolated web build.",
    "//   node --experimental-strip-types src/forge/gen-dashboard-types.ts \\",
    "//     web/src/types/dashboard.generated.ts",
    "// See P1-S7 / C8 for the CI wiring task.",
    "",
    `export type RunStatus = ${runStatusType};`,
    "",
    `export type TaskStatus = ${taskStatusType};`,
    "",
    `export type ReviewState = ${reviewStateType};`,
    "",
    `export type ReviewSeverity = ${reviewSeverityType};`,
    "",
    `export type GateReviewRole = ${gateRoleType};`,
    "",
    `export type RoutingRecommendationKind = ${routingKindType};`,
    "",
    `export type AuthorityLabel = ${authorityLabelType};`,
    "",
    `export type BlockerKind = ${blockerKindType};`,
    "",
    `export type PulseState = ${pulseStateType};`,
    "",
    `export type RunHeaderViewModel = ${zodTypeToTs(headerSchema, 0)};`,
    "",
    `export type BlockerViewModel = ${zodTypeToTs(blockerSchema, 0)};`,
    "",
    `export type TaskQueueEntryViewModel = ${zodTypeToTs(taskQueueEntrySchema, 0)};`,
    "",
    `export type ReviewGateViewModel = ${zodTypeToTs(reviewGateSchema, 0)};`,
    "",
    `export type RunPulseViewModel = ${zodTypeToTs(pulseSchema, 0)};`,
    "",
    `export type DashboardViewModel = ${zodTypeToTs(schema, 0)};`,
    "",
  ];

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * Resolve + bounds-check the output path argument.
 * Must stay within the repo root and end in `.ts`.
 *
 * Resolution order:
 *   - Absolute path: used as-is.
 *   - Relative path: resolved against `cwd` (defaults to process.cwd()), so
 *     invoking from web/ with `src/types/dashboard.generated.ts` lands in
 *     `<web-cwd>/src/types/dashboard.generated.ts` as expected.
 *
 * @param arg     CLI argument (path string or undefined).
 * @param repoRoot Repo root used for the containment check. Defaults to the
 *                 computed repo root of this module.
 * @param cwd     Base for resolving relative paths. Defaults to process.cwd().
 */
export function resolveOutputPath(
  arg: string | undefined,
  repoRoot: string = REPO_ROOT,
  cwd: string = process.cwd()
): string {
  if (arg === undefined) {
    throw new Error(
      "gen-dashboard-types: output path argument required. " +
        "Usage: node --experimental-strip-types src/forge/gen-dashboard-types.ts <output-path>"
    );
  }
  // Resolve relative paths against cwd, absolute paths as-is.
  const resolved = resolve(cwd, arg);
  if (resolved !== repoRoot && !resolved.startsWith(`${repoRoot}${sep}`)) {
    throw new Error(
      `gen-dashboard-types: output path must stay within the repository (${repoRoot}); ` +
        `refusing to write to ${resolved}`
    );
  }
  if (!resolved.endsWith(".ts")) {
    throw new Error(
      `gen-dashboard-types: output path must end in .ts; got ${resolved}`
    );
  }
  return resolved;
}

function main(): void {
  const outputPath = resolveOutputPath(process.argv[2]);
  const content = emitTypes(DashboardViewModelSchema);
  writeFileSync(outputPath, content, "utf8");
  process.stderr.write(
    `gen-dashboard-types: wrote ${outputPath}\n`
  );
}

// Guard: only run as CLI entry point, not when imported by tests or other modules.
function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}
const invokedPath =
  typeof process.argv[1] === "string" ? canonicalPath(process.argv[1]) : "";
if (
  invokedPath !== "" &&
  canonicalPath(fileURLToPath(import.meta.url)) === invokedPath
) {
  main();
}
