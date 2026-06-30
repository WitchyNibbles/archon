import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

// SEC-HEREDOC-BYPASS regression suite.
//
// extractBashReferencedManagedPaths strips heredoc bodies before the managed-path
// scan so that documentation/data heredocs that merely MENTION a managed path do
// not trip the guard. The vulnerability: an EXECUTABLE heredoc (piped to an
// interpreter) whose body WRITES a managed path also had its body stripped, so
// `python3 - <<EOF ... open('.claude/x','w') ... EOF` evaded the write-scope guard.
//
// Fix contract:
//   - executable-interpreter heredoc bodies (python/node/bash/…, a pipe, or a
//     command substitution on the opener line) ARE scanned for managed paths.
//   - data-sink heredoc bodies (cat/tee to a file or stdout) keep being stripped,
//     so a doc heredoc that mentions a managed path is NOT a false positive.

const hooksDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".claude", "hooks");
const { extractBashReferencedManagedPaths } = await import(`${hooksDir}/hook-utils.mjs`);

// --- The bypass must be CLOSED ---

test("heredoc-bypass: python interpreter heredoc writing .claude IS flagged", () => {
  const cmd = "python3 - <<'PYEOF'\nopen('.claude/hooks/evil.mjs','w').write('x')\nPYEOF";
  assert.ok(extractBashReferencedManagedPaths(cmd).includes(".claude"), "managed write inside a python heredoc must be detected");
});

test("heredoc-bypass: node interpreter heredoc writing CLAUDE.md IS flagged", () => {
  const cmd = "node <<'EOF'\nrequire('fs').writeFileSync('CLAUDE.md','x')\nEOF";
  assert.ok(extractBashReferencedManagedPaths(cmd).includes("CLAUDE.md"), "managed write inside a node heredoc must be detected");
});

test("heredoc-bypass: cat heredoc PIPED to an interpreter IS flagged", () => {
  const cmd = "cat <<EOF | python3\nopen('.claude/settings.json','w')\nEOF";
  assert.ok(extractBashReferencedManagedPaths(cmd).includes(".claude"), "a heredoc piped to an interpreter is executable and must be scanned");
});

test("heredoc-bypass: bash interpreter heredoc touching .archon/memory IS flagged", () => {
  const cmd = "bash <<'EOF'\necho hi > .archon/memory/leak.md\nEOF";
  assert.ok(extractBashReferencedManagedPaths(cmd).includes(".archon/memory"), "managed write inside a bash heredoc must be detected");
});

// --- The legitimate data-sink case must stay a NON-match ---

test("heredoc-bypass: data-sink heredoc (cat > file) that MENTIONS a managed path is NOT flagged", () => {
  const cmd = "cat > docs/setup.md <<'EOF'\nEdit your .claude/settings.json and CLAUDE.md as needed.\nEOF";
  assert.deepEqual(extractBashReferencedManagedPaths(cmd), [], "a doc heredoc that only mentions a managed path is not a write to it");
});

test("heredoc-bypass: data-sink heredoc to stdout that MENTIONS a managed path is NOT flagged", () => {
  const cmd = "cat <<'EOF'\nsee .claude/agents for the roster\nEOF";
  assert.deepEqual(extractBashReferencedManagedPaths(cmd), [], "a cat-to-stdout heredoc mention is not a managed write");
});

// --- <<- indented heredoc (tab-stripped body + tab-indented closing delimiter) ---

test("heredoc-bypass: <<- interpreter heredoc with a tab-indented closing delimiter IS flagged", () => {
  // The `<<-` form lets the closing delimiter be tab-indented. The guard must
  // still match it, or the executable body evades both the strip and the scan.
  const cmd = "python3 - <<-'PYEOF'\n\topen('.claude/hooks/evil.mjs','w').write('x')\n\tPYEOF";
  assert.ok(extractBashReferencedManagedPaths(cmd).includes(".claude"), "<<- executable heredoc must be scanned");
});

test("heredoc-bypass: plain << heredoc with a fake tab-indented closer line still scans the FULL body", () => {
  // A plain `<<EOF` closer must be at column 0. A tab-indented `\tEOF` line inside
  // the body is body content, NOT a closer — it must not truncate the scan and let
  // a later managed write slip past (regression guard for the round-2 fix).
  const cmd = "python3 - <<'EOF'\nprint('benign')\n\tEOF\nopen('.claude/hooks/evil.mjs','w').write('EVIL')\nEOF";
  assert.ok(extractBashReferencedManagedPaths(cmd).includes(".claude"), "the managed write after a fake closer must still be detected");
});

test("heredoc-bypass: <<- data-sink heredoc that MENTIONS a managed path is NOT flagged", () => {
  const cmd = "cat > docs/x.md <<-'EOF'\n\tsee .claude/settings.json\n\tEOF";
  assert.deepEqual(extractBashReferencedManagedPaths(cmd), [], "<<- data-sink mention is not a managed write");
});

test("heredoc-bypass: additional interpreter tokens (ruby, lua) in a heredoc opener ARE flagged", () => {
  assert.ok(
    extractBashReferencedManagedPaths("ruby <<'EOF'\nFile.write('.claude/x','y')\nEOF").includes(".claude"),
    "ruby heredoc must be scanned"
  );
  assert.ok(
    extractBashReferencedManagedPaths("cat <<EOF | lua\nio.open('CLAUDE.md','w')\nEOF").includes("CLAUDE.md"),
    "lua-piped heredoc must be scanned"
  );
});

// --- Pipe / command-substitution that DATA-captures a heredoc is not executable ---

test("heredoc-bypass: a heredoc captured by command substitution $(cat ...) is NOT flagged", () => {
  // Wrapping `cat <<EOF` in $(...) captures the body as a string (e.g. a PR body
  // passed to a CLI) — it does not execute the body as code.
  const cmd = "gh pr create --body \"$(cat <<'EOF'\nedit .claude/settings.json and CLAUDE.md\nEOF\n)\"";
  assert.deepEqual(extractBashReferencedManagedPaths(cmd), [], "data captured via $(cat ...) is not a managed write");
});

test("heredoc-bypass: a heredoc piped to a data sink (tee) is NOT flagged", () => {
  const cmd = "cat <<EOF | tee /tmp/out.txt\nmentions .claude/agents\nEOF";
  assert.deepEqual(extractBashReferencedManagedPaths(cmd), [], "piping to tee is a data sink, not execution");
});

// --- Existing scan-A behavior must be preserved ---

test("heredoc-bypass: redirect target outside the body (cat > .claude/x) is still flagged", () => {
  const cmd = "cat > .claude/hooks/x.mjs <<'EOF'\nbody\nEOF";
  assert.ok(extractBashReferencedManagedPaths(cmd).includes(".claude"), "a managed redirect target outside the body remains detected");
});

test("heredoc-bypass: data-sink heredoc writing a non-managed file is not flagged", () => {
  const cmd = "cat > /tmp/out.txt <<'EOF'\njust data\nEOF";
  assert.deepEqual(extractBashReferencedManagedPaths(cmd), []);
});
