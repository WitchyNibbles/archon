import type { ExportDocsRequest, ExportDocsSummary } from "./models.ts";

function quoteYaml(value: string): string {
  return JSON.stringify(value);
}

function renderBullets(values: readonly string[]): string[] {
  if (values.length === 0) {
    return ["- none"];
  }
  return values.map((value) => `- ${value}`);
}

function renderCheckboxes(values: readonly string[]): string[] {
  if (values.length === 0) {
    return ["- [ ] none recorded"];
  }
  return values.map((value) => `- [ ] ${value}`);
}

function buildTags(request: ExportDocsRequest): string[] {
  return [
    request.project ?? "devgod",
    request.format === "daily_summary" ? "worklog" : "documentation",
    "documentation",
    "exported"
  ];
}

export class ObsidianMarkdownRenderer {
  render(summary: ExportDocsSummary, request: ExportDocsRequest): string {
    const lines: string[] = [
      "---",
      `title: ${quoteYaml(summary.title)}`,
      `date: ${request.dateFrom ?? new Date().toISOString().slice(0, 10)}`,
      `project: ${request.project ?? "devgod"}`,
      `type: ${request.format}`,
      "tags:"
    ];

    for (const tag of buildTags(request)) {
      lines.push(`  - ${tag}`);
    }

    lines.push(`source: ${(request.project ?? "devgod")}`);
    lines.push("---");
    lines.push("");
    lines.push(`# ${summary.title}`);
    lines.push("");

    if (request.includeSections.includes("summary")) {
      lines.push("## Summary");
      lines.push("");
      lines.push(summary.summary);
      lines.push("");
    }

    if (request.includeSections.includes("topics")) {
      lines.push("## Main topics");
      lines.push("");
      lines.push(...renderBullets(summary.topics));
      lines.push("");
    }

    if (request.includeSections.includes("decisions")) {
      lines.push("## Decisions made");
      lines.push("");
      lines.push(...renderBullets(summary.decisions));
      lines.push("");
    }

    if (request.includeSections.includes("tasks")) {
      lines.push("## Tasks");
      lines.push("");
      lines.push(...renderCheckboxes(summary.tasks));
      lines.push("");
    }

    if (request.includeSections.includes("bugs")) {
      lines.push("## Bugs / issues");
      lines.push("");
      lines.push(...renderBullets(summary.bugs));
      lines.push("");
    }

    if (request.includeSections.includes("files")) {
      lines.push("## Files or areas touched");
      lines.push("");
      lines.push(...renderBullets(summary.files));
      lines.push("");
    }

    if (request.includeSections.includes("next_steps")) {
      lines.push("## Next steps");
      lines.push("");
      lines.push(...renderCheckboxes(summary.nextSteps));
      lines.push("");
    }

    lines.push("## Related notes");
    lines.push("");
    lines.push(...renderBullets(summary.relatedNotes));
    lines.push("");

    return `${lines.join("\n")}\n`;
  }
}
