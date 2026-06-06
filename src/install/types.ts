export type InstallMode = "apply" | "dry-run";

export interface InstallOptions {
  sourceRoot: string;
  targetRoot: string;
  dryRun?: boolean;
  withGitNexus?: boolean;
  withGrafana?: boolean;
  withObsidian?: boolean;
}

export interface InstallSummary {
  mode: InstallMode;
  writesPerformed: boolean;
  created: string[];
  updated: string[];
  skipped: string[];
  backups: string[];
  plannedBackups: string[];
  conflicts: string[];
  orphans: string[];
  runtimeRegistration?: string | undefined;
  runtimeBackupManifest?: string | undefined;
  runtimeMigrationReport?: string | undefined;
  nextSteps: string[];
}

export interface VerifySummary {
  ok: boolean;
  missing: string[];
  modified: string[];
  orphans: string[];
}

export interface WorkflowScaffoldOptions {
  sourceRoot: string;
  targetRoot: string;
  taskId: string;
  force?: boolean;
  forceActive?: boolean;
}

export interface WorkflowScaffoldSummary {
  created: string[];
  updated: string[];
  nextSteps: string[];
  taskId: string;
}
