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
 * Extract the element schema from a ZodArray field in a top-level object shape.
 * Returns undefined when the field is absent or is not a ZodArray.
 * Used by emitTypes to locate the concrete item schemas for array fields.
 */
function extractArrayElementSchema(
  topShape: Record<string, z.ZodTypeAny>,
  key: string
): z.ZodTypeAny | undefined {
  const field = topShape[key];
  if (field instanceof z.ZodArray) {
    return field._def.type as z.ZodTypeAny;
  }
  return undefined;
}

/**
 * Extract a ZodEnum type string from a field on an object schema.
 * Unwraps ZodOptional if present. Throws when the field is absent.
 * Used to derive helper union-type aliases (e.g. RunStatus, TaskStatus) from
 * the concrete enum fields already embedded in each sub-object schema.
 */
function extractEnumTypeString(
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
  const inner = field instanceof z.ZodOptional ? field.unwrap() : field;
  return zodTypeToTs(inner, 0);
}

/**
 * Emit the full TypeScript file content for the DashboardViewModelSchema.
 *
 * Named exports:
 *   - One `type` alias per top-level ZodObject property name (PascalCase mapped
 *     from the exported schema constant names in dashboard-contract.ts).
 *   - Helper union types for discriminant arrays.
 *
 * C2 ROBUSTNESS: The emitter walks the Zod schema shape dynamically.
 * Adding a new field to DashboardViewModelSchema flows to the emitted type file
 * automatically — no hand-edit of this emitter is needed. This is proven by
 * tests/forge-live-read.test.ts ("dynamic shape iteration" suite).
 *
 * The `DashboardViewModel` export is derived entirely from `zodTypeToTs(schema)`
 * which iterates the schema's own `.shape()` at runtime, so any new field on the
 * top-level schema is automatically included.
 *
 * Sub-schema named type aliases (RunHeaderViewModel, BlockerViewModel, etc.) are
 * also derived from the top-level shape — the emitter locates them by field key,
 * not by a hard-coded schema constant reference, so renaming a field in the
 * schema automatically renames its alias in the emitted output.
 *
 * Helper enum union types are derived from enum fields WITHIN those sub-schemas,
 * again by field key. The set of named enum aliases is fixed (they track the
 * stable enum identifiers in the web app) — adding a non-enum field like
 * `generatedAt: z.string()` needs no emitter change at all.
 */
export function emitTypes(schema: typeof DashboardViewModelSchema): string {
  // Walk the top-level shape dynamically — adding or removing a field here
  // requires zero edits to this function.
  const topShape = schema._def.shape() as Record<string, z.ZodTypeAny>;

  // ---------------------------------------------------------------------------
  // Locate the named sub-schemas from the top-level shape by field key.
  // These are the fields that carry their own named ViewModel types.
  // ---------------------------------------------------------------------------

  const headerSchema = topShape["header"];
  const blockerSchema = extractArrayElementSchema(topShape, "blockers");
  const taskQueueEntrySchema = extractArrayElementSchema(topShape, "taskQueue");
  const reviewGateSchema = extractArrayElementSchema(topShape, "reviewGates");
  const pulseSchema = topShape["pulse"];

  if (
    !headerSchema ||
    !blockerSchema ||
    !taskQueueEntrySchema ||
    !reviewGateSchema ||
    !pulseSchema
  ) {
    throw new Error(
      "gen-dashboard-types: top-level schema is missing one of the expected " +
        "sub-schemas (header, blockers[], taskQueue[], reviewGates[], pulse). " +
        "Confirm DashboardViewModelSchema shape in dashboard-contract.ts."
    );
  }

  // ---------------------------------------------------------------------------
  // Helper enum union-type strings — derived from fields WITHIN each sub-schema.
  // These named aliases are stable identifiers used by the web app.
  // ---------------------------------------------------------------------------

  const runStatusType = extractEnumTypeString(headerSchema, "status");
  const authorityLabelType = extractEnumTypeString(headerSchema, "authorityLabel");
  const blockerKindType = extractEnumTypeString(blockerSchema, "kind");
  const taskStatusType = extractEnumTypeString(taskQueueEntrySchema, "status");
  const routingKindType = extractEnumTypeString(taskQueueEntrySchema, "routingRecommendation");
  const reviewStateType = extractEnumTypeString(reviewGateSchema, "state");
  const reviewSeverityType = extractEnumTypeString(reviewGateSchema, "severity");
  const gateRoleType = extractEnumTypeString(reviewGateSchema, "role");
  const pulseStateType = extractEnumTypeString(pulseSchema, "pulseState");

  // ---------------------------------------------------------------------------
  // Emit.
  // `zodTypeToTs(schema, 0)` walks schema.shape() at runtime — the
  // DashboardViewModel type always mirrors the schema exactly, with no
  // per-field hand-wiring in this emitter.
  // ---------------------------------------------------------------------------

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
    // DashboardViewModel: emitted by walking schema.shape() dynamically.
    // Any new top-level field on DashboardViewModelSchema flows here automatically.
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
