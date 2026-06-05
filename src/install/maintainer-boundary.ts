const maintainerOnlyScripts = [
  "test:properties",
  "eval:promptfoo:maintainer-boundary",
  "test:mutation:maintainer-boundary",
  "test:mutation:maintainer-boundary:dry-run"
] as const;

const maintainerOnlyDevDependencies = [
  "fast-check",
  "promptfoo",
  "@stryker-mutator/core",
  "@stryker-mutator/tap-runner",
  "tsx"
] as const;

const maintainerOnlyPathPrefixes = [
  "docs/maintainers/",
  "evals/promptfoo/"
] as const;

const maintainerOnlyExactPaths = [
  "stryker-maintainer-boundary.config.json"
] as const;

export const MAINTAINER_ONLY_SCRIPTS = [...maintainerOnlyScripts];
export const MAINTAINER_ONLY_DEV_DEPENDENCIES = [...maintainerOnlyDevDependencies];

export interface MaintainerOnlyPackageJsonAudit {
  scriptLeaks: string[];
  devDependencyLeaks: string[];
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

export function auditMaintainerOnlyPackageJson(packageJson: unknown): MaintainerOnlyPackageJsonAudit {
  const record = packageJson && typeof packageJson === "object" && !Array.isArray(packageJson)
    ? (packageJson as Record<string, unknown>)
    : {};
  const scripts = asStringRecord(record.scripts);
  const devDependencies = asStringRecord(record.devDependencies);

  return {
    scriptLeaks: MAINTAINER_ONLY_SCRIPTS.filter((key) => key in scripts),
    devDependencyLeaks: MAINTAINER_ONLY_DEV_DEPENDENCIES.filter((key) => key in devDependencies)
  };
}

export function auditMaintainerOnlyPublishedPaths(paths: readonly string[]): string[] {
  return [...new Set(paths.filter((relativePath) =>
    maintainerOnlyPathPrefixes.some((prefix) => relativePath.startsWith(prefix)) ||
    maintainerOnlyExactPaths.includes(relativePath as (typeof maintainerOnlyExactPaths)[number])
  ))].sort();
}
