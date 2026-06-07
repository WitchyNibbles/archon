import { appendBypassLogEntry, readActiveTaskContext, readHookPayload } from "./hook-utils.mjs";
import { evaluateUserPromptSubmit } from "./hook-policy.mjs";

const payload = await readHookPayload();
const context = await readActiveTaskContext();
const prompt = typeof payload?.prompt === "string" ? payload.prompt : "";

if (prompt.includes("archon:bypass")) {
  appendBypassLogEntry(context.repoRoot, prompt);
}

const response = evaluateUserPromptSubmit(payload, context);

if (response) {
  process.stdout.write(JSON.stringify(response));
}
