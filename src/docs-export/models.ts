import type {
  ApprovalRecord,
  HandoffRecord,
  MemoryEntryRecord,
  PlanArtifact,
  ReviewRecord,
  RunRecord,
  TaskRecord
} from "../domain/types.ts";

export const exportDocFormats = [
  "daily_summary",
  "project_summary",
  "feature_doc",
  "decision_log"
] as const;

export const exportDocSections = [
  "summary",
  "topics",
  "decisions",
  "tasks",
  "bugs",
  "files",
  "next_steps"
] as const;

export type ExportDocFormat = (typeof exportDocFormats)[number];
export type ExportDocSection = (typeof exportDocSections)[number];

export interface ExportDocsRequest {
  rawQuery: string;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  project?: string | undefined;
  format: ExportDocFormat;
  style?: string | undefined;
  includeSections: ExportDocSection[];
  destination: string;
  timezone: string;
}

export interface ExportDocsSummary {
  title: string;
  summary: string;
  topics: string[];
  decisions: string[];
  tasks: string[];
  bugs: string[];
  files: string[];
  nextSteps: string[];
  relatedNotes: string[];
}

export interface WorklogEntry {
  run: RunRecord;
  plan?: PlanArtifact | undefined;
  tasks: TaskRecord[];
  handoffsByTask: Record<string, HandoffRecord[]>;
  reviewsByTask: Record<string, ReviewRecord[]>;
  approvalsByTask: Record<string, ApprovalRecord[]>;
  decisionMemoryEntries: MemoryEntryRecord[];
}

export interface ObsidianExportConfig {
  enabled: boolean;
  vaultPath?: string | undefined;
  defaultProject: string;
  dailyFolder: string;
  docsFolder: string;
  adrFolder: string;
  timezone: string;
}

export interface ExportDocsCommandResult {
  request: ExportDocsRequest;
  summary?: ExportDocsSummary | undefined;
  targetPath?: string | undefined;
  vaultIndexPath?: string | undefined;
  message: string;
  matchedEntries: number;
}
