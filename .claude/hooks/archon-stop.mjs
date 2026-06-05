import { readActiveTaskContext, readHookPayload } from "./hook-utils.mjs";
import { evaluateStop } from "./hook-policy.mjs";

const payload = await readHookPayload();
const context = await readActiveTaskContext();
const response = evaluateStop(payload, context);

if (response) {
  process.stdout.write(JSON.stringify(response));
}
