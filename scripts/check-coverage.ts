import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const result = execSync(
  "node --experimental-strip-types --test --test-reporter=spec tests/*.test.ts",
  { cwd: repoRoot, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
);
process.stdout.write(result);
process.stdout.write("\nNote: formal coverage measurement requires vitest or c8. Run `npx c8 npm test` for a coverage report.\n");
