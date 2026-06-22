// CLI flag parsing helpers — dependency-free leaf module. Extracted from workflow.ts
// so daemon submodules (and anything else) can parse argv flags without importing
// workflow.ts, which participates in a module cycle. Behavior-preserving move.

export function resolveCommandFlag(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}

export function collectCommandFlagValues(args: readonly string[], flag: string): string[] {
  const values: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) {
      continue;
    }

    const value = args[index + 1];
    if (!value || value.startsWith("-")) {
      throw new Error(`${flag} requires a value`);
    }
    values.push(value);
    index += 1;
  }

  return values;
}

export function resolveFormatFlag(args: readonly string[]): "json" | "text" {
  const format = resolveCommandFlag(args, "--format") ?? "json";
  if (format !== "json" && format !== "text") {
    throw new Error(`Invalid --format value: ${format}`);
  }
  return format;
}
