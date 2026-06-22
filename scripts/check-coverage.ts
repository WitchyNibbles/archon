import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Real coverage gate. Runs the full test suite under c8 and enforces the ratchet
// floors configured in package.json ("c8" key: check-coverage + lines/statements/
// functions/branches). Exits non-zero on a test failure OR when coverage drops
// below the floor. Raise the floors over time as coverage improves (e.g. once large
// untested modules like daemon.ts are decomposed and unit-tested). This replaces the
// previous no-op note that performed no measurement.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  execSync("npx c8 node --experimental-strip-types --test tests/*.test.ts", {
    cwd: repoRoot,
    stdio: "inherit"
  });
} catch {
  // c8 exits non-zero on a test failure or a coverage floor breach. Fail explicitly
  // so the gate cannot be silently swallowed by a future wrapper around this script.
  process.exit(1);
}
