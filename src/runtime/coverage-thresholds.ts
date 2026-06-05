export interface CoverageSummary {
  line: number;
  branch: number;
  funcs: number;
}

export interface CoverageThresholds {
  line: number;
  branch: number;
  funcs: number;
}

export interface CoverageFileSummary extends CoverageSummary {
  file: string;
}

export interface ParsedCoverageReport {
  aggregate: CoverageSummary | null;
  files: CoverageFileSummary[];
}

interface CoveragePathFrame {
  depth: number;
  name: string;
}

const summaryPattern =
  /# all files\s+\|\s+([0-9]+(?:\.[0-9]+)?)\s+\|\s+([0-9]+(?:\.[0-9]+)?)\s+\|\s+([0-9]+(?:\.[0-9]+)?)/;
const fileRowPattern =
  /^#(\s+)([^|]+?)\s+\|\s+([0-9]+(?:\.[0-9]+)?)\s+\|\s+([0-9]+(?:\.[0-9]+)?)\s+\|\s+([0-9]+(?:\.[0-9]+)?)/;
const directoryRowPattern = /^#(\s+)([^|]+?)\s+\|\s*\|\s*\|\s*\|/;

function parsePercent(value: string): number {
  return Number.parseFloat(value);
}

function resolveCoveragePath(
  frames: CoveragePathFrame[],
  indentLength: number,
  name: string
): string {
  const depth = Math.max(0, indentLength - 1);
  const trimmedName = name.trim();

  while (frames.length > depth) {
    frames.pop();
  }

  const currentPath = [...frames.map((frame) => frame.name), trimmedName].join("/");
  if (!trimmedName.includes(".")) {
    frames.push({ depth, name: trimmedName });
  }

  return currentPath;
}

export function parseCoverageSummary(output: string): CoverageSummary | null {
  const match = output.match(summaryPattern);
  if (!match) {
    return null;
  }

  return {
    line: parsePercent(match[1]!),
    branch: parsePercent(match[2]!),
    funcs: parsePercent(match[3]!)
  };
}

export function parseCoverageReport(output: string): ParsedCoverageReport {
  const files: CoverageFileSummary[] = [];
  const frames: CoveragePathFrame[] = [];

  for (const line of output.split(/\r?\n/)) {
    const directoryMatch = line.match(directoryRowPattern);
    if (directoryMatch) {
      resolveCoveragePath(frames, directoryMatch[1]!.length, directoryMatch[2]!);
      continue;
    }

    const fileMatch = line.match(fileRowPattern);
    if (!fileMatch) {
      continue;
    }

    const indent = fileMatch[1]!;
    const name = fileMatch[2]!;
    const linePct = fileMatch[3]!;
    const branchPct = fileMatch[4]!;
    const funcsPct = fileMatch[5]!;
    if (name.trim() === "all files") {
      continue;
    }
    const file = resolveCoveragePath(frames, indent.length, name);
    files.push({
      file,
      line: parsePercent(linePct),
      branch: parsePercent(branchPct),
      funcs: parsePercent(funcsPct)
    });
  }

  return {
    aggregate: parseCoverageSummary(output),
    files
  };
}

export function validateCoverageThresholds(
  summary: CoverageSummary,
  thresholds: CoverageThresholds
): string[] {
  const failures: string[] = [];

  if (summary.line < thresholds.line) {
    failures.push(`line coverage ${summary.line.toFixed(2)}% is below ${thresholds.line.toFixed(2)}%`);
  }

  if (summary.branch < thresholds.branch) {
    failures.push(`branch coverage ${summary.branch.toFixed(2)}% is below ${thresholds.branch.toFixed(2)}%`);
  }

  if (summary.funcs < thresholds.funcs) {
    failures.push(`function coverage ${summary.funcs.toFixed(2)}% is below ${thresholds.funcs.toFixed(2)}%`);
  }

  return failures;
}

export function validatePerFileCoverage(input: {
  files: readonly CoverageFileSummary[];
  expectedFiles: readonly string[];
  requiredCoverage: CoverageThresholds;
}): string[] {
  const failures: string[] = [];
  const coverageByFile = new Map(input.files.map((file) => [file.file, file]));

  for (const expectedFile of input.expectedFiles) {
    const summary = coverageByFile.get(expectedFile);
    if (!summary) {
      failures.push(`missing coverage for ${expectedFile}`);
      continue;
    }

    if (summary.line < input.requiredCoverage.line) {
      failures.push(
        `${expectedFile} line coverage ${summary.line.toFixed(2)}% is below ${input.requiredCoverage.line.toFixed(2)}%`
      );
    }

    if (summary.branch < input.requiredCoverage.branch) {
      failures.push(
        `${expectedFile} branch coverage ${summary.branch.toFixed(2)}% is below ${input.requiredCoverage.branch.toFixed(2)}%`
      );
    }

    if (summary.funcs < input.requiredCoverage.funcs) {
      failures.push(
        `${expectedFile} function coverage ${summary.funcs.toFixed(2)}% is below ${input.requiredCoverage.funcs.toFixed(2)}%`
      );
    }
  }

  return failures;
}
