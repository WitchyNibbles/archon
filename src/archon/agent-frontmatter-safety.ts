// Escape-safety guard for rendered YAML frontmatter scalars. Extracted from
// agent-frontmatter.ts as its own module (single cohesive concern).
//
// `\`/`"` break the verifier's stripYamlScalar round-trip (it does not unescape
// them). C0 control characters — including a raw CR/LF — are rejected too: a
// newline in a rendered scalar could inject a fake `---` frontmatter delimiter
// into the block, a structural-injection risk, not just an escaping bug.
//
// Checked by char code (not a regex) so no literal control character needs to
// be embedded in source — this also avoids ESLint's no-control-regex rule.
function hasUnsafeScalarChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x5c || code === 0x22 || code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Reject `\`, `"`, or any control char (CR/LF included) in a rendered scalar.
 *  Throws naming the offending field and agent so a poisoned catalog entry
 *  fails loudly instead of silently corrupting the generate→verify round-trip. */
export function assertScalarsSafeForRoundTrip(
  scalars: ReadonlyArray<{ field: string; value: string }>,
  agentName: string
): void {
  for (const { field, value } of scalars) {
    if (hasUnsafeScalarChar(value)) {
      throw new Error(
        `renderAgentFrontmatter: agent "${agentName}" field "${field}" has an unsafe char (backslash/quote/control). Value: ${JSON.stringify(value)}`
      );
    }
  }
}
