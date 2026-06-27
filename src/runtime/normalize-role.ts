// normalize-role — shared injection-proof role boundary.
//
// Extracted from interactive-parachute.ts so that handoff-controller.ts can
// import it without creating a circular dependency (interactive-parachute.ts
// imports from handoff-controller.ts; if handoff-controller.ts imported from
// interactive-parachute.ts we would have a cycle).
//
// Security rationale: the context-guard.json `role` field and ARCHON_ROLE env
// are both attacker-writable (any subagent/MCP with env access or file-write
// scope can set them). normalizeRole is the authoritative boundary — callers
// must not skip it by pre-validating upstream.

/**
 * Constrain a role string to a strict, bounded token before it can flow into
 * HandoffController identity fields (fromRole/toRole). buildContinuationPrompt
 * embeds toRole in the TRUSTED identity section without further sanitization,
 * so the value must never contain newlines, spaces, section markers, or
 * arbitrary length. Anything that does not match `^[a-z][a-z0-9_-]{0,39}$`
 * falls back to the safe default "interactive".
 *
 * This is the authoritative boundary: the context-guard.json `role` field and
 * ARCHON_ROLE env are both untrusted (attacker-writable), so validation here
 * cannot be skipped by a caller that wrote a clean value upstream.
 */
export function normalizeRole(raw: unknown): string {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (/^[a-z][a-z0-9_-]{0,39}$/.test(trimmed)) {
      return trimmed;
    }
  }
  return "interactive";
}
