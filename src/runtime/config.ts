import os from "node:os";
import path from "node:path";

export interface RuntimeEnvironmentConfig {
  runtimeMode: RuntimeMode;
  runtimeProfile: string;
  dataRoot: string;
  installManifestPath: string;
}

export const runtimeModes = ["docker", "native", "managed"] as const;
export type RuntimeMode = (typeof runtimeModes)[number];

function normalizeRuntimeMode(candidate: string): RuntimeMode | "auto" {
  const normalized = candidate.trim().toLowerCase();
  switch (normalized) {
    case "":
    case "auto":
      return "auto";
    case "docker":
    case "native":
    case "managed":
      return normalized;
    default:
      throw new Error(`invalid runtime mode: ${candidate}`);
  }
}

export function runtimeProfileForMode(mode: RuntimeMode): string {
  switch (mode) {
    case "docker":
      return "local-docker";
    case "native":
      return "local-native";
    case "managed":
      return "managed";
  }
}

export function runtimeModeFromProfile(profile: string): RuntimeMode {
  const normalized = profile.trim().toLowerCase();
  if (normalized === "managed" || normalized.startsWith("managed")) {
    return "managed";
  }
  if (normalized === "local-native" || normalized.startsWith("local-native")) {
    return "native";
  }
  if (normalized === "local-docker" || normalized.startsWith("local-docker")) {
    return "docker";
  }
  if (normalized.startsWith("local")) {
    return "docker";
  }
  throw new Error(`invalid runtime profile: ${profile}`);
}

function defaultRuntimeDataRoot(projectSlug: string): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "archon", projectSlug);
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "archon", projectSlug);
  }

  return path.join(os.homedir(), ".local", "share", "archon", projectSlug);
}

export function resolveRuntimeEnvironmentConfig(
  env: NodeJS.ProcessEnv,
  options: {
    projectSlug: string;
    cwd?: string | undefined;
  }
): RuntimeEnvironmentConfig {
  const requestedRuntimeMode = normalizeRuntimeMode(env.ARCHON_RUNTIME_MODE?.trim() ?? "auto");
  const runtimeProfile =
    requestedRuntimeMode === "auto"
      ? env.ARCHON_RUNTIME_PROFILE?.trim() || "local-docker"
      : runtimeProfileForMode(requestedRuntimeMode);
  const runtimeMode = runtimeModeFromProfile(runtimeProfile);
  const dataRoot = env.ARCHON_RUNTIME_DATA_ROOT?.trim() || defaultRuntimeDataRoot(options.projectSlug);

  return {
    runtimeMode,
    runtimeProfile,
    dataRoot: path.resolve(options.cwd ?? process.cwd(), dataRoot),
    installManifestPath:
      env.ARCHON_INSTALL_MANIFEST_PATH?.trim() ||
      path.join(options.cwd ?? process.cwd(), ".archon", "install-manifest.json")
  };
}
