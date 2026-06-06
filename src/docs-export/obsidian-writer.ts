import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

export function sanitizeMarkdownFilename(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  return sanitized.length > 0 ? sanitized : "note";
}

function assertPathInsideVault(vaultPath: string, candidatePath: string): void {
  const relative = path.relative(vaultPath, candidatePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write outside the configured Obsidian vault: ${candidatePath}`);
  }
}

export function formatWikilink(title: string): string {
  return `[[${title}]]`;
}

export function injectWikilinks(markdown: string, relatedTitles: readonly string[]): string {
  if (relatedTitles.length === 0) return markdown;
  const linkSection = relatedTitles.map((t) => `- ${formatWikilink(t)}`).join("\n");
  if (markdown.includes("## Related notes")) {
    return markdown.replace(/## Related notes\n([\s\S]*?)(\n##|$)/, `## Related notes\n${linkSection}\n$2`);
  }
  return `${markdown}\n## Related notes\n\n${linkSection}\n`;
}

export class ObsidianVaultWriter {
  private readonly vaultPath: string;

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath;
  }

  resolveTargetPath(targetPath: string): string {
    const resolved = path.resolve(this.vaultPath, targetPath);
    assertPathInsideVault(this.vaultPath, resolved);
    return resolved;
  }

  async writeNote(markdown: string, targetPath: string, overwrite = false): Promise<string> {
    const resolvedPath = this.resolveTargetPath(targetPath);
    const parentDir = path.dirname(resolvedPath);
    await mkdir(parentDir, { recursive: true });

    try {
      await access(resolvedPath);
      if (!overwrite) {
        throw new Error(`Refusing to overwrite existing Obsidian note: ${resolvedPath}`);
      }
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code !== "" && code !== "ENOENT") {
        throw error;
      }
      if (code === "" && error instanceof Error && error.message.startsWith("Refusing to overwrite")) {
        throw error;
      }
    }

    await writeFile(resolvedPath, markdown, "utf8");
    return resolvedPath;
  }

  async writeVaultIndex(folder: string, projectName: string, date: string): Promise<string> {
    const folderPath = path.resolve(this.vaultPath, folder);
    assertPathInsideVault(this.vaultPath, folderPath);

    let entries: string[] = [];
    try {
      const files = await readdir(folderPath);
      entries = files
        .filter((f) => f.endsWith(".md") && f !== "_INDEX.md")
        .map((f) => `- ${formatWikilink(f.replace(/\.md$/, ""))}`);
    } catch {
      entries = [];
    }

    const content = [
      "---",
      `title: "Project Brain — ${projectName}"`,
      `date: ${date}`,
      `project: ${projectName}`,
      `type: vault_index`,
      "tags:",
      "  - index",
      "  - project-brain",
      "---",
      "",
      `# Project Brain — ${projectName}`,
      "",
      "> Auto-generated index. Navigate with Obsidian Graph View or follow wikilinks.",
      "> For codebase structure, see [[graph/GRAPH_REPORT]] if graphify has been run.",
      "",
      "## Notes in this folder",
      "",
      ...(entries.length > 0 ? entries : ["- none yet"]),
      ""
    ].join("\n");

    return this.writeNote(content, path.join(folder, "_INDEX.md"), true);
  }
}
