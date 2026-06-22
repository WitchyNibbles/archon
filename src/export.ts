// Obsidian / docs export command surface.
// Extracted verbatim from src/admin.ts (P8-T1 split). MOVE ONLY — no logic changes.
import process from "node:process";








import { withClient } from "./admin/db.ts";






import { parseExportDocsRequest } from "./docs-export/parser.ts";
import { resolveObsidianConfig, validateObsidianConfig } from "./docs-export/obsidian-config.ts";
import { DocsSummarizer } from "./docs-export/summarizer.ts";
import { ObsidianMarkdownRenderer } from "./docs-export/renderer.ts";
import { ObsidianVaultWriter } from "./docs-export/obsidian-writer.ts";
import { buildObsidianTargetPath } from "./docs-export/targets.ts";
import { RuntimeWorklogProvider, type WorklogProvider } from "./docs-export/worklog-provider.ts";










import type { ExportDocsCommandResult } from "./docs-export/models.ts";
import { collectCommandFreeText, resolveCommandFlag } from "./workflow.ts";
import type { EnvShape } from "./workflow.ts";
import { createRuntimeStore } from "./runtime.ts";


export interface ExecuteExportDocsCommandOptions {
  cwd?: string | undefined;
  env?: EnvShape | undefined;
  now?: Date | undefined;
  resolveObsidianConfig?: typeof resolveObsidianConfig | undefined;
  validateObsidianConfig?: typeof validateObsidianConfig | undefined;
  createWorklogProvider: (input: {
    workspaceSlug: string;
    projectSlug: string;
  }) => WorklogProvider;
}


export async function executeExportDocsCommandFromArgs(
  args: readonly string[],
  options: ExecuteExportDocsCommandOptions
): Promise<ExportDocsCommandResult> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const workspaceSlug = resolveCommandFlag(args, "--workspace-slug") ?? env.ARCHON_WORKSPACE_SLUG;
  const projectSlug = resolveCommandFlag(args, "--project-slug") ?? env.ARCHON_PROJECT_SLUG;

  if (!workspaceSlug || !projectSlug) {
    throw new Error("export-docs requires ARCHON_WORKSPACE_SLUG and ARCHON_PROJECT_SLUG or explicit flags");
  }

  const resolveObsidianConfigImpl = options.resolveObsidianConfig ?? resolveObsidianConfig;
  const validateObsidianConfigImpl = options.validateObsidianConfig ?? validateObsidianConfig;
  const config = resolveObsidianConfigImpl(env, {
    cwd,
    projectSlug
  });
  await validateObsidianConfigImpl(config);

  const rawQuery = collectCommandFreeText(args, {
    valueFlags: ["--workspace-slug", "--project-slug"],
    booleanFlags: ["--overwrite"]
  });
  const request = parseExportDocsRequest(rawQuery, config, {
    now: options.now
  });
  const provider = options.createWorklogProvider({
    workspaceSlug,
    projectSlug
  });
  const entries = await provider.getEntries(request);

  if (entries.length === 0) {
    const dateLabel =
      request.dateFrom && request.dateTo && request.dateFrom === request.dateTo
        ? request.dateFrom
        : request.dateFrom && request.dateTo
          ? `${request.dateFrom} to ${request.dateTo}`
          : "the requested range";
    return {
      request,
      message: `No matching worklog entries found for ${dateLabel}. No note was created.`,
      matchedEntries: 0
    };
  }

  const summary = new DocsSummarizer().summarize(entries, request);
  const markdown = new ObsidianMarkdownRenderer().render(summary, request);
  const writer = new ObsidianVaultWriter(config.vaultPath!);
  const targetPath = await writer.writeNote(markdown, buildObsidianTargetPath(request, summary), args.includes("--overwrite"));
  const vaultIndexPath = await writer.writeVaultIndex(
    request.destination,
    projectSlug,
    request.dateFrom ?? new Date().toISOString().slice(0, 10)
  );

  return {
    request,
    summary,
    targetPath,
    vaultIndexPath,
    message: `Exported Obsidian note:\n${targetPath}\nVault index updated:\n${vaultIndexPath}`,
    matchedEntries: entries.length
  };
}


export async function exportDocsCommand(args: readonly string[]) {
  await withClient(async (client) => {
    const result = await executeExportDocsCommandFromArgs(args, {
      cwd: process.cwd(),
      env: process.env,
      createWorklogProvider({ workspaceSlug, projectSlug }) {
        return new RuntimeWorklogProvider(createRuntimeStore(client), {
          workspaceSlug,
          projectSlug
        });
      }
    });

    process.stdout.write(`${result.message}\n`);
  });
}
