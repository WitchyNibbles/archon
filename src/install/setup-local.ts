import { access } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit"
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
    });

    child.on("error", (error) => {
      reject(error);
    });
  });
}

async function main(): Promise<void> {
  const targetRoot = process.cwd();

  if (process.platform === "win32") {
    const targetScript = (await fileExists(path.join(targetRoot, "scripts", "archon-setup.ps1")))
      ? path.join(targetRoot, "scripts", "archon-setup.ps1")
      : path.join(targetRoot, "scripts", "setup-archon.ps1");

    await run("powershell", [
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      targetScript
    ], targetRoot);
    return;
  }

  const targetScript = (await fileExists(path.join(targetRoot, "scripts", "archon-setup.sh")))
    ? path.join(targetRoot, "scripts", "archon-setup.sh")
    : path.join(targetRoot, "scripts", "setup-archon.sh");

  await run("bash", [targetScript], targetRoot);
}

const entryUrl = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";

if (import.meta.url === entryUrl) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
