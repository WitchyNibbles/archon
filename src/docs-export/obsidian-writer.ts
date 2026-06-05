import { access, mkdir, writeFile } from "node:fs/promises";
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
}
