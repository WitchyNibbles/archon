import { readActiveTaskContext, readHookPayload } from "./hook-utils.mjs";
import { evaluatePermissionRequest } from "./hook-policy.mjs";

const payload = await readHookPayload();
const context = await readActiveTaskContext(
  typeof payload?.cwd === "string" && payload.cwd.trim().length > 0
    ? { repoRoot: payload.cwd }
    : {}
);
const response = evaluatePermissionRequest(payload, context);

if (response) {
  process.stdout.write(JSON.stringify(response));
}
