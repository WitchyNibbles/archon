import { readActiveTaskContext, readHookPayload } from "./hook-utils.mjs";
import { evaluatePreToolUse } from "./hook-policy.mjs";

const payload = await readHookPayload();
const context = await readActiveTaskContext();
const response = evaluatePreToolUse(payload, context);

if (response) {
  process.stdout.write(JSON.stringify(response));
}
