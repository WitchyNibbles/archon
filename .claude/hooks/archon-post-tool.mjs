import { readActiveTaskContext, readHookPayload } from "./hook-utils.mjs";
import { evaluatePostToolUse } from "./hook-policy.mjs";

const payload = await readHookPayload();
const context = await readActiveTaskContext();
const response = evaluatePostToolUse(payload, context);

if (response) {
  process.stdout.write(JSON.stringify(response));
}
