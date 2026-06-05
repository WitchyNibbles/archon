import { currentIsoDateInTimezone, resolveDateRangeFromQuery } from "./date-resolver.ts";
import type { ExportDocFormat, ExportDocSection, ExportDocsRequest, ObsidianExportConfig } from "./models.ts";

const defaultSections: ExportDocSection[] = ["summary", "topics", "decisions", "tasks", "next_steps"];
const allSections: ExportDocSection[] = ["summary", "topics", "decisions", "tasks", "bugs", "files", "next_steps"];

function detectFormat(rawQuery: string): ExportDocFormat {
  const normalized = rawQuery.toLowerCase();
  if (/\b(decision|decisions|adr)\b/.test(normalized)) {
    return "decision_log";
  }
  if (/\b(feature|documentation|document|doc)\b/.test(normalized)) {
    return "feature_doc";
  }
  if (/\bproject summary\b/.test(normalized)) {
    return "project_summary";
  }
  return "daily_summary";
}

function detectStyle(rawQuery: string): string | undefined {
  const normalized = rawQuery.toLowerCase();
  if (/\b(listed|list|bullet)\b/.test(normalized)) {
    return "listed";
  }
  if (/\bconcise|brief\b/.test(normalized)) {
    return "concise";
  }
  return undefined;
}

function detectSections(rawQuery: string): ExportDocSection[] {
  const normalized = rawQuery.toLowerCase();
  if (/\ball\b/.test(normalized)) {
    return [...allSections];
  }

  const sections = new Set<ExportDocSection>(defaultSections);
  if (/\btopic|topics\b/.test(normalized)) {
    sections.add("topics");
  }
  if (/\bdecision|decisions|adr\b/.test(normalized)) {
    sections.add("decisions");
  }
  if (/\btask|tasks\b/.test(normalized)) {
    sections.add("tasks");
  }
  if (/\bbug|bugs|issue|issues\b/.test(normalized)) {
    sections.add("bugs");
  }
  if (/\bfile|files|touched|areas\b/.test(normalized)) {
    sections.add("files");
  }
  if (/\bnext step|next steps\b/.test(normalized)) {
    sections.add("next_steps");
  }

  return [...sections];
}

function resolveDestination(format: ExportDocFormat, config: ObsidianExportConfig): string {
  if (format === "feature_doc" || format === "project_summary") {
    return config.docsFolder;
  }
  if (format === "decision_log") {
    return config.adrFolder;
  }
  return config.dailyFolder;
}

export function parseExportDocsRequest(
  rawQuery: string,
  config: ObsidianExportConfig,
  options: {
    now?: Date | undefined;
  } = {}
): ExportDocsRequest {
  const trimmed = rawQuery.trim();
  if (trimmed.length === 0) {
    throw new Error("export-docs requires a natural-language request after the command name");
  }

  const format = detectFormat(trimmed);
  const resolvedDates = resolveDateRangeFromQuery(trimmed, {
    timezone: config.timezone,
    now: options.now
  });

  const today = currentIsoDateInTimezone(options.now ?? new Date(), config.timezone);
  const fallbackDates =
    format === "daily_summary" && !resolvedDates.dateFrom && !resolvedDates.dateTo
      ? { dateFrom: today, dateTo: today }
      : resolvedDates;

  return {
    rawQuery: trimmed,
    dateFrom: fallbackDates.dateFrom,
    dateTo: fallbackDates.dateTo,
    project: config.defaultProject,
    format,
    style: detectStyle(trimmed),
    includeSections: detectSections(trimmed),
    destination: resolveDestination(format, config),
    timezone: config.timezone
  };
}
