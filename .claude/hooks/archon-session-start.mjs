import { readActiveTaskContext, readHookPayload } from "./hook-utils.mjs";
import { evaluateSessionStart } from "./hook-policy.mjs";

const payload = await readHookPayload();
const context = await readActiveTaskContext();
const response = evaluateSessionStart(payload, context);

if (response) {
  process.stdout.write(JSON.stringify(response));
}
