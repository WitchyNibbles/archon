import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath: string): Promise<string> {
  return readFile(path.join(sourceRoot, relativePath), "utf8");
}

test("archon intake guidance requires clarification and explicit assumptions", async () => {
  const skill = await read(".claude/skills/archon-intake/SKILL.md");

  assert.match(skill, /Ask (1-4 )?concise clarifying questions before planning/i);
  assert.match(skill, /state the operating assumptions explicitly/i);
  assert.match(skill, /Treat refactors as behavior-preserving improvement work/i);
});

test("archon autopilot guidance keeps iterating until verified completion", async () => {
  const skill = await read(".claude/skills/archon-autopilot/SKILL.md");

  assert.match(skill, /Do not wait for the user to say "continue"/i);
  assert.match(skill, /including good-path and bad-path coverage/i);
  assert.match(skill, /never stop after a single passing command/i);
});

test("workflow templates encode clarification, regression, and risk-closure expectations", async () => {
  const intakeBrief = await read(".archon/templates/intake-brief.md");
  const taskPacket = await read(".archon/templates/task-packet.md");
  const qualityMatrix = await read(".archon/rules/task-quality-matrix.md");
  const reasoningQuality = await read(".archon/rules/reasoning-quality.md");

  assert.match(intakeBrief, /## Clarifying questions/);
  assert.match(intakeBrief, /## Assumptions/);
  assert.match(intakeBrief, /## Reasoning quality/);
  assert.match(intakeBrief, /## Bad-path or edge-case outcomes/);

  assert.match(taskPacket, /`regression_safety_required`/);
  assert.match(taskPacket, /`council_review_required`/);
  assert.match(taskPacket, /`coverage_ledger_required`/);
  assert.match(taskPacket, /`progress_proof_required`/);
  assert.match(taskPacket, /`checkpoint_resume_required`/);
  assert.match(taskPacket, /## Behavior to preserve/);
  assert.match(taskPacket, /## Reasoning quality/);
  assert.match(taskPacket, /## Reasoning policy/);
  assert.match(taskPacket, /## Reasoning attempts/);
  assert.match(taskPacket, /## Coverage impact/);
  assert.match(taskPacket, /## Touched ledger items/);
  assert.match(taskPacket, /## Required runtime traces/);
  assert.match(taskPacket, /## Progress proof/);
  assert.match(taskPacket, /## Interrupt checkpoint policy/);
  assert.match(taskPacket, /## Workflow artifact refs/);
  assert.match(taskPacket, /## Council review/);
  assert.match(taskPacket, /### Dissent owner/);
  assert.match(taskPacket, /review_exports=required \| runtime_optional/);
  assert.match(taskPacket, /## Bad-path or edge-case checks/);
  assert.match(taskPacket, /## Residual risk disposition/);

  assert.match(qualityMatrix, /### `council_review_required`/);
  assert.match(qualityMatrix, /refactors and rewrites must preserve intended behavior/i);
  assert.match(qualityMatrix, /### `regression_safety_required`/);
  assert.match(qualityMatrix, /### `coverage_ledger_required`/);
  assert.match(qualityMatrix, /### `progress_proof_required`/);
  assert.match(qualityMatrix, /### `checkpoint_resume_required`/);
  assert.match(qualityMatrix, /### `reasoning_strict_required`/);
  assert.match(qualityMatrix, /discovered `CRITICAL` or `HIGH` defects in touched scope/i);
  assert.match(reasoningQuality, /facts, assumptions, and guesses/i);
  assert.match(reasoningQuality, /structured dissent pass/i);
  assert.match(reasoningQuality, /multiple plausible hypotheses/i);
  assert.match(reasoningQuality, /strict is the default reasoning mode/i);
  assert.match(reasoningQuality, /dual mode is the migration bridge/i);
  assert.match(reasoningQuality, /bounded research, debug, and review budgets/i);
});

test("reasoning-quality skills call for bounded skepticism and evidence discipline", async () => {
  const debugging = await read(".claude/skills/archon-debugging/SKILL.md");
  const planning = await read(".claude/skills/archon-planning/SKILL.md");
  const review = await read(".claude/skills/archon-review/SKILL.md");
  const docsResearch = await read(".claude/skills/archon-docs-research/SKILL.md");

  assert.match(debugging, /next most plausible hypothesis/i);
  assert.match(debugging, /debug budget/i);
  assert.match(debugging, /repo-local Grafana configuration/i);
  assert.match(debugging, /counter-evidence/i);
  assert.match(planning, /reasoning-quality section/i);
  assert.match(planning, /strict.*default/i);
  assert.match(review, /low-confidence conclusions/i);
  assert.match(review, /unsupported reasoning verdicts/i);
  assert.match(docsResearch, /unresolved drift/i);
  assert.match(docsResearch, /repo-local Grafana configuration/i);
  assert.match(docsResearch, /stop at the evidence boundary/i);
});

test("expanded role-local workflow skills encode the new behavior loops", async () => {
  const agentRuntime = await read(".claude/skills/archon-agent-runtime/SKILL.md");
  const productFraming = await read(".claude/skills/archon-product-framing/SKILL.md");
  const gitOperator = await read(".claude/skills/archon-git-operator/SKILL.md");
  const evalEngineering = await read(".claude/skills/archon-eval-engineering/SKILL.md");
  const skillEvals = await read(".claude/skills/archon-skill-evals/SKILL.md");

  assert.match(agentRuntime, /continuation/i);
  assert.match(agentRuntime, /hook/i);
  assert.match(productFraming, /smallest useful milestone/i);
  assert.match(productFraming, /acceptance criteria/i);
  assert.match(gitOperator, /Stage only files that belong/i);
  assert.match(gitOperator, /do not use broad staging commands/i);
  assert.match(evalEngineering, /deterministic checks/i);
  assert.match(evalEngineering, /false-positive risk/i);
  assert.match(skillEvals, /did the right skill trigger/i);
  assert.match(skillEvals, /happy-path/i);
});

test("frontend quality controls reject generic AI UI and require browser-backed proof", async () => {
  const frontendTaste = await read(".claude/skills/archon-frontend-taste/SKILL.md");
  const frontendRubric = await read(".archon/rules/frontend-quality-rubric.md");
  const frontendDesigner = await read(".claude/agents/frontend-designer/AGENT.md");

  assert.match(frontendTaste, /generic gradient hero/i);
  assert.match(frontendTaste, /mobile layout must feel composed/i);
  assert.match(frontendRubric, /generic AI-generated UI output/i);
  assert.match(frontendRubric, /default font stack/i);
  assert.match(frontendRubric, /one desktop viewport/i);
  assert.match(frontendRubric, /one mobile viewport/i);
  assert.match(frontendRubric, /cited Playwright evidence refs/i);
  assert.match(frontendDesigner, /frontend quality rubric/i);
});

test("AGENTS routes recurring control-layer work through repo-local workflow skills first", async () => {
  const agents = await read("CLAUDE.md");

  assert.match(agents, /repo-local `archon-\*` workflow skill/i);
  assert.match(agents, /agent runtime, hook, tool-contract, automation, or continuation changes/i);
  assert.match(agents, /benchmark, grader, or skill-regression work/i);
  assert.match(agents, /operator docs, migration notes, release notes.*workflow-document clarity/i);
  assert.match(agents, /src\/docs-export\/.*archon-technical-writing/i);
});
