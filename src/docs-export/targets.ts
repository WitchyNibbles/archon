import path from "node:path";
import type { ExportDocsRequest, ExportDocsSummary } from "./models.ts";
import { sanitizeMarkdownFilename } from "./obsidian-writer.ts";

function isoRangeLabel(request: ExportDocsRequest): string {
  if (request.dateFrom && request.dateTo && request.dateFrom === request.dateTo) {
    return request.dateFrom;
  }
  if (request.dateFrom && request.dateTo) {
    return `${request.dateFrom}-${request.dateTo}`;
  }
  return new Date().toISOString().slice(0, 10);
}

export function buildObsidianTargetPath(
  request: ExportDocsRequest,
  summary: ExportDocsSummary
): string {
  if (request.format === "daily_summary") {
    return path.join(request.destination, `${request.dateFrom ?? isoRangeLabel(request)}.md`);
  }

  if (request.format === "decision_log") {
    return path.join(
      request.destination,
      `${isoRangeLabel(request)}-${sanitizeMarkdownFilename(summary.title)}.md`
    );
  }

  return path.join(request.destination, `${sanitizeMarkdownFilename(summary.title)}.md`);
}
