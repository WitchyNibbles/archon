/**
 * @module admin/secret
 *
 * Admin subcommand: `archon secret <verb>`
 *
 * Sub-verbs:
 *   secret set <ref> [--from-file <path>] [--from-env <VARNAME>]
 *   secret rotate <ref> [--from-file <path>] [--from-env <VARNAME>]
 *   secret list
 *   secret delete <ref>
 *
 * ## CC-13 — no plaintext residue (the security crux)
 *
 * The secret VALUE is NEVER accepted as:
 *   - A positional command-line argument
 *   - A `--value` flag
 *   These paths would land in shell history, `process.argv`, and `/proc/cmdline`.
 *
 * Value input modes (one of three, mutually exclusive):
 *   1. `--from-file <path>`:
 *      - Open with O_NOFOLLOW (rejects symlinks at open time — TOCTOU-safe).
 *      - fstat the open file descriptor to verify mode bits.
 *      - Reject world- or group-readable files (mode & 0o077 !== 0).
 *      - Read the value from the descriptor — never copy the file.
 *   2. `--from-env <VARNAME>`:
 *      - Read `process.env[VARNAME]` (or sandbox env) silently — never echo.
 *      - Delete `env[VARNAME]` immediately after reading.
 *      - Print an instruction to remove it from `.env.archon` and clear shell history.
 *   3. Default — masked stdin prompt:
 *      - Read the value through the injectable `readSecretValue` dep.
 *      - The default implementation uses `readline` with terminal echo disabled.
 *      - Never echo or log the result.
 *
 * ## Dep-injection
 *
 * All I/O surfaces are injectable via `SecretCommandDeps`:
 *   - `backend`       — `SecretManager` instance (default: `createSecretManager()`).
 *   - `readSecretValue` — masked value reader (default: real masked stdin prompt).
 *   - `env`           — environment object (default: `process.env`).
 *   - `stdout`        — output stream (default: `process.stdout`).
 *   - `stderr`        — error stream (default: `process.stderr`).
 *
 * Tests MUST inject a fake `readSecretValue` and an in-memory backend so no TTY
 * or real FS is required.
 */

import { openSync, fstatSync, readFileSync, closeSync, constants as fsConstants } from "node:fs";
import readline from "node:readline";
import type { SecretManager, SecretRef } from "../secrets/secret-manager.ts";
import { parseSecretRef } from "../secrets/secret-manager.ts";
import { createSecretValue } from "../secrets/secret-value.ts";
import type { SecretValue } from "../secrets/secret-value.ts";
import { createSecretManager } from "../secrets/secret-store-factory.ts";

// ---------------------------------------------------------------------------
// Value-reader type
// ---------------------------------------------------------------------------

/**
 * Injectable value reader.
 *
 * The production implementation reads a masked (echoed as `*`) line from stdin.
 * Test implementations return a fixed string without any I/O.
 *
 * The reader MUST:
 *   - Never echo the raw value to stdout or stderr.
 *   - Resolve to the raw secret string.
 *   - Throw if input is cancelled / empty.
 */
export type SecretValueReader = (prompt: string) => Promise<string>;

// ---------------------------------------------------------------------------
// Dep-injection interface
// ---------------------------------------------------------------------------

export interface SecretCommandDeps {
  /** The SecretManager to read/write to. Default: `createSecretManager()`. */
  readonly backend?: SecretManager;
  /** Value reader for masked stdin prompt. Default: real masked readline prompt. */
  readonly readSecretValue?: SecretValueReader;
  /** Environment object. Default: `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Output stream for user-facing messages. Default: `process.stdout`. */
  readonly stdout?: NodeJS.WriteStream;
  /** Error output stream. Default: `process.stderr`. */
  readonly stderr?: NodeJS.WriteStream;
}

// ---------------------------------------------------------------------------
// Arg parser
// ---------------------------------------------------------------------------

interface ParsedArgs {
  readonly verb: string;
  readonly ref: string | undefined;
  readonly fromFile: string | undefined;
  readonly fromEnv: string | undefined;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const verb = args[0] ?? "";
  let ref: string | undefined;
  let fromFile: string | undefined;
  let fromEnv: string | undefined;

  let i = 1;
  while (i < args.length) {
    const arg: string | undefined = args[i];
    if (arg === undefined) break;
    if (arg === "--from-file") {
      fromFile = args[i + 1];
      i += 2;
    } else if (arg === "--from-env") {
      fromEnv = args[i + 1];
      i += 2;
    } else if (arg === "--value") {
      // CC-13: --value is explicitly forbidden. Detect it and error out loudly
      // rather than silently accepting it (defense-in-depth guard).
      throw new Error(
        "The --value flag is not supported. " +
          "Passing a secret via --value would expose it in shell history and process listings. " +
          "Use --from-file, --from-env, or the default masked stdin prompt instead.",
      );
    } else if (!arg.startsWith("--")) {
      if (ref === undefined) {
        ref = arg;
      } else {
        // A second positional arg after ref would be an inline value — reject it.
        // CC-13: no positional secret value.
        throw new Error(
          `Unexpected positional argument: "${arg}". ` +
            "Passing a secret as a positional argument would expose it in shell history. " +
            "Use --from-file, --from-env, or the default masked stdin prompt instead.",
        );
      }
      i++;
    } else {
      throw new Error(`Unknown flag: "${arg}"`);
    }
  }

  return { verb, ref, fromFile, fromEnv };
}

// ---------------------------------------------------------------------------
// File value reader (CC-13 O_NOFOLLOW + fstat + perms check)
// ---------------------------------------------------------------------------

/**
 * Reads the secret value from a file path with security checks.
 *
 * Guards:
 *   - O_NOFOLLOW: rejects symlinks at open time (TOCTOU-safe).
 *   - fstat on the file descriptor (not the path) — the stat reflects what was
 *     actually opened, not a path that might change.
 *   - mode & 0o077 !== 0: rejects world- or group-readable files. The operator
 *     must restrict the file to 0o600 or 0o400 (owner-only).
 *   - The file is never copied anywhere.
 *
 * @throws If the path is a symlink, the file is world/group-readable, or
 *   the file cannot be read.
 */
function readValueFromFile(filePath: string): string {
  /** Upper bound — a secret file should be tiny; refuse to slurp a huge file into memory. */
  const MAX_SECRET_FILE_BYTES = 1024 * 1024; // 1 MiB

  let fd: number;
  try {
    // O_NOFOLLOW rejects symlinks at open time.
    fd = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    const msg = err instanceof Error ? err.message : String(err);
    // O_NOFOLLOW on a symlink surfaces as ELOOP (or ENOTDIR on some platforms).
    if (code === "ELOOP" || code === "ENOTDIR" || msg.includes("ELOOP") || msg.includes("ENOTDIR")) {
      throw new Error(
        `--from-file: "${filePath}" is a symbolic link. ` +
          "Symbolic links are rejected to prevent TOCTOU attacks. " +
          "Provide a regular file path instead.",
      );
    }
    throw new Error(`--from-file: cannot open "${filePath}": ${msg}`);
  }

  // The fd MUST be closed on every path (success or throw) — close in finally.
  try {
    // fstat the open descriptor — not the path — for TOCTOU safety.
    const stat = fstatSync(fd);

    // Reject anything that is not a regular file (e.g. a directory or device).
    if (!stat.isFile()) {
      throw new Error(`--from-file: "${filePath}" is not a regular file. No secret was stored.`);
    }

    // Check for world- or group-readable bits (mode & 0o077 must be zero).
    if ((stat.mode & 0o077) !== 0) {
      const modeOctal = (stat.mode & 0o777).toString(8).padStart(3, "0");
      throw new Error(
        `--from-file: "${filePath}" has mode 0${modeOctal} which is world- or group-readable. ` +
          "Secret files must be accessible only by the owner (e.g. chmod 0600 or chmod 0400). " +
          "No secret was stored.",
      );
    }

    // Size cap: a secret file is tiny; refuse to read a huge file into memory.
    if (stat.size > MAX_SECRET_FILE_BYTES) {
      throw new Error(
        `--from-file: "${filePath}" is ${stat.size} bytes, exceeding the ${MAX_SECRET_FILE_BYTES}-byte ` +
          "limit for a secret file. No secret was stored.",
      );
    }

    // Read the value from the file descriptor (not the path).
    const buf = readFileSync(fd);

    // Trim trailing newline(s) — common when the file was created with `echo`.
    const raw = buf.toString("utf-8").trimEnd();

    if (raw.length === 0) {
      throw new Error(`--from-file: "${filePath}" is empty. No secret was stored.`);
    }

    return raw;
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Env-var value reader (CC-13 --from-env scrub)
// ---------------------------------------------------------------------------

/**
 * Reads and scrubs the secret value from an env-var name.
 *
 * CC-13 guards:
 *   - Reads silently — never echoes the value.
 *   - Immediately deletes the var from `env` after reading.
 *   - Returns the value and the scrub instruction string (caller prints it).
 *
 * @throws If the variable is not set or is empty.
 */
function readValueFromEnv(
  varName: string,
  env: NodeJS.ProcessEnv,
): { value: string; instruction: string } {
  const raw = env[varName];

  if (raw === undefined || raw === "") {
    throw new Error(
      `--from-env: environment variable "${varName}" is not set or is empty. ` +
        "Set it before running this command.",
    );
  }

  // CC-13: delete immediately after reading.
  delete env[varName];

  const instruction =
    `\nIMPORTANT — follow these steps to remove the secret residue:\n` +
    `  1. Remove "${varName}=" from your .env.archon file (or wherever it is set).\n` +
    `  2. Clear your shell history:\n` +
    `       bash:  history -d <line-number>  or  history -c\n` +
    `       zsh:   fc -p; history -d <line-number>  or  unset HISTFILE\n` +
    `       fish:  builtin history delete --prefix <partial-command>\n` +
    `  3. Verify the variable is no longer set: echo $${varName} (should be empty).\n`;

  return { value: raw, instruction };
}

// ---------------------------------------------------------------------------
// Default masked stdin reader
// ---------------------------------------------------------------------------

/**
 * Default production value reader.
 *
 * Prompts the user on stderr, disables terminal echo while they type, then
 * restores echo after.  The typed characters are never written to stdout.
 *
 * This is NOT used in tests — tests inject a fake reader.
 */
export function makeDefaultSecretValueReader(): SecretValueReader {
  return async (prompt: string): Promise<string> => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });

    return new Promise<string>((resolve, reject) => {
      // Disable stdin echo so the value is masked.
      // @ts-expect-error — _writeToOutput is not in the public TS types but is
      // the standard way to disable echo in Node readline.
      rl._writeToOutput = () => undefined;

      process.stderr.write(prompt);

      rl.question("", (answer) => {
        rl.close();
        process.stderr.write("\n");
        if (answer.length === 0) {
          reject(new Error("Secret input was empty. No secret was stored."));
        } else {
          resolve(answer);
        }
      });

      rl.on("close", () => {
        // Called if stdin closes (e.g. Ctrl-D) before an answer is given.
        reject(new Error("Secret input was cancelled. No secret was stored."));
      });
    });
  };
}

// ---------------------------------------------------------------------------
// Value acquisition dispatcher
// ---------------------------------------------------------------------------

/**
 * Acquires the secret value via the appropriate CC-13 input mode.
 *
 * Returns the raw value string and an optional post-store message to print.
 */
async function acquireValue(
  fromFile: string | undefined,
  fromEnv: string | undefined,
  env: NodeJS.ProcessEnv,
  reader: SecretValueReader,
): Promise<{ raw: string; postMessage?: string }> {
  if (fromFile !== undefined && fromEnv !== undefined) {
    throw new Error("--from-file and --from-env cannot be used together. Choose one.");
  }

  if (fromFile !== undefined) {
    const raw = readValueFromFile(fromFile);
    return { raw };
  }

  if (fromEnv !== undefined) {
    const { value: raw, instruction } = readValueFromEnv(fromEnv, env);
    return { raw, postMessage: instruction };
  }

  // Default: masked stdin prompt.
  const raw = await reader("Enter secret value (input is hidden): ");
  return { raw };
}

// ---------------------------------------------------------------------------
// Sub-verb implementations
// ---------------------------------------------------------------------------

async function runSet(
  ref: string | undefined,
  parsed: ParsedArgs,
  backend: SecretManager,
  env: NodeJS.ProcessEnv,
  reader: SecretValueReader,
  stdout: NodeJS.WriteStream,
): Promise<void> {
  if (ref === undefined || ref === "") {
    throw new Error("secret set requires a <ref> argument. Usage: archon secret set <ref> [--from-file <path>|--from-env <VAR>]");
  }

  const secretRef: SecretRef = parseSecretRef(ref);
  const { raw, postMessage } = await acquireValue(parsed.fromFile, parsed.fromEnv, env, reader);
  const value: SecretValue = createSecretValue(raw);

  await backend.set(secretRef, value);

  stdout.write(`Secret "${secretRef}" stored.\n`);
  if (postMessage !== undefined) {
    stdout.write(postMessage);
  }
}

async function runRotate(
  ref: string | undefined,
  parsed: ParsedArgs,
  backend: SecretManager,
  env: NodeJS.ProcessEnv,
  reader: SecretValueReader,
  stdout: NodeJS.WriteStream,
): Promise<void> {
  if (ref === undefined || ref === "") {
    throw new Error("secret rotate requires a <ref> argument. Usage: archon secret rotate <ref> [--from-file <path>|--from-env <VAR>]");
  }

  const secretRef: SecretRef = parseSecretRef(ref);
  const { raw, postMessage } = await acquireValue(parsed.fromFile, parsed.fromEnv, env, reader);
  const value: SecretValue = createSecretValue(raw);

  try {
    await backend.rotate(secretRef, value);
  } catch (err: unknown) {
    // Surface the "no secret exists" error from the backend clearly (not just a generic failure).
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("no secret exists") || msg.includes("rotate:")) {
      throw new Error(
        `secret rotate: ${msg} — ` +
          `Use "archon secret set ${secretRef}" to create it first.`,
      );
    }
    throw err;
  }

  stdout.write(`Secret "${secretRef}" rotated.\n`);
  if (postMessage !== undefined) {
    stdout.write(postMessage);
  }
}

async function runList(
  backend: SecretManager,
  stdout: NodeJS.WriteStream,
): Promise<void> {
  const refs = await backend.list();

  if (refs.length === 0) {
    stdout.write("No secrets stored.\n");
    return;
  }

  stdout.write("Stored secret refs:\n");
  for (const ref of refs) {
    // Print ONLY the ref — never the value.
    stdout.write(`  ${ref}\n`);
  }
}

async function runDelete(
  ref: string | undefined,
  backend: SecretManager,
  stdout: NodeJS.WriteStream,
): Promise<void> {
  if (ref === undefined || ref === "") {
    throw new Error("secret delete requires a <ref> argument. Usage: archon secret delete <ref>");
  }

  const secretRef: SecretRef = parseSecretRef(ref);
  await backend.delete(secretRef);
  stdout.write(`Secret "${secretRef}" deleted (or was not present).\n`);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Executes the `archon secret` subcommand.
 *
 * @param args - `process.argv.slice(3)` — the arguments after "secret".
 * @param deps - Optional injectable dependencies for testing.
 */
export async function secretCommand(
  args: readonly string[],
  deps?: SecretCommandDeps,
): Promise<void> {
  const stdout: NodeJS.WriteStream = (deps?.stdout as NodeJS.WriteStream | undefined) ?? process.stdout;
  const stderr: NodeJS.WriteStream = (deps?.stderr as NodeJS.WriteStream | undefined) ?? process.stderr;
  const env: NodeJS.ProcessEnv = deps?.env ?? process.env;
  const reader: SecretValueReader = deps?.readSecretValue ?? makeDefaultSecretValueReader();

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`archon secret: ${msg}\n`);
    process.exit(1);
  }

  // Lazy-init backend so tests can inject before the factory is called.
  const backend: SecretManager = deps?.backend ?? createSecretManager({ env });

  try {
    switch (parsed.verb) {
      case "set":
        await runSet(parsed.ref, parsed, backend, env, reader, stdout);
        break;

      case "rotate":
        await runRotate(parsed.ref, parsed, backend, env, reader, stdout);
        break;

      case "list":
        await runList(backend, stdout);
        break;

      case "delete":
        await runDelete(parsed.ref, backend, stdout);
        break;

      default: {
        const helpMsg =
          `Usage: archon secret <verb> [options]\n` +
          `\n` +
          `Verbs:\n` +
          `  set <ref> [--from-file <path>] [--from-env <VAR>]\n` +
          `    Store a secret.  Value is read from a file (--from-file), an env var\n` +
          `    (--from-env), or a masked stdin prompt (default).  NO positional value.\n` +
          `\n` +
          `  rotate <ref> [--from-file <path>] [--from-env <VAR>]\n` +
          `    Replace an EXISTING secret (fails if not present — use set to create).\n` +
          `\n` +
          `  list\n` +
          `    Print stored secret refs only (never values).\n` +
          `\n` +
          `  delete <ref>\n` +
          `    Remove a secret.\n`;

        stderr.write(helpMsg);
        process.exit(parsed.verb === "" ? 0 : 1);
      }
    }
  } catch (err: unknown) {
    // SECURITY: never echo the secret value or the master key in error output.
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`archon secret ${parsed.verb}: ${msg}\n`);
    process.exit(1);
  }
}
