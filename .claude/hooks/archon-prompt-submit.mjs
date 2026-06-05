import { readActiveTaskContext, readHookPayload } from "./hook-utils.mjs";
import { evaluateUserPromptSubmit } from "./hook-policy.mjs";

const payload = await readHookPayload();
const context = await readActiveTaskContext();
const response = evaluateUserPromptSubmit(payload, context);

if (response) {
  process.stdout.write(JSON.stringify(response));
}
