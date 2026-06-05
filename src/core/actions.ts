import type { HandoffInput, IntakeRequestInput, MemoryPromotionInput, PlanInput, ReviewInput, SearchMemoryInput, TaskPacketInput } from "../domain/types.ts";
import { ArchonCoreService } from "./service.ts";

export interface ArchonActionHandlers {
  intake_request(input: IntakeRequestInput): ReturnType<ArchonCoreService["intakeRequest"]>;
  create_plan(input: PlanInput): ReturnType<ArchonCoreService["createPlan"]>;
  create_task_graph(input: {
    runId: string;
    taskPackets: TaskPacketInput[];
  }): ReturnType<ArchonCoreService["createTaskGraph"]>;
  claim_task(input: { runId: string; taskId: string; actor: string }): ReturnType<
    ArchonCoreService["claimTask"]
  >;
  submit_handoff(input: { runId: string; taskId: string; handoff: HandoffInput }): ReturnType<
    ArchonCoreService["submitHandoff"]
  >;
  record_review(input: { runId: string; taskId: string; actor: string; review: ReviewInput }): ReturnType<
    ArchonCoreService["recordReview"]
  >;
  promote_memory(input: { runId: string; memory: MemoryPromotionInput }): ReturnType<
    ArchonCoreService["promoteMemory"]
  >;
  search_memory(input: SearchMemoryInput): ReturnType<ArchonCoreService["searchMemory"]>;
  get_status(input: { runId: string }): ReturnType<ArchonCoreService["getStatus"]>;
  get_execution_plan(input: { runId: string }): ReturnType<ArchonCoreService["getExecutionPlan"]>;
  resume_run(input: { runId: string }): ReturnType<ArchonCoreService["resumeRun"]>;
  recommend_routing(input: { runId: string }): ReturnType<ArchonCoreService["recommendRouting"]>;
}

export function createActionHandlers(service: ArchonCoreService): ArchonActionHandlers {
  return {
    intake_request(input) {
      return service.intakeRequest(input);
    },
    create_plan(input) {
      return service.createPlan(input);
    },
    create_task_graph(input) {
      return service.createTaskGraph(input.runId, input.taskPackets);
    },
    claim_task(input) {
      return service.claimTask(input.runId, input.taskId, input.actor);
    },
    submit_handoff(input) {
      return service.submitHandoff(input.runId, input.taskId, input.handoff);
    },
    record_review(input) {
      return service.recordReview(input.runId, input.taskId, input.actor, input.review);
    },
    promote_memory(input) {
      return service.promoteMemory(input.runId, input.memory);
    },
    search_memory(input) {
      return service.searchMemory(input);
    },
    get_status(input) {
      return service.getStatus(input.runId);
    },
    get_execution_plan(input) {
      return service.getExecutionPlan(input.runId);
    },
    resume_run(input) {
      return service.resumeRun(input.runId);
    },
    recommend_routing(input) {
      return service.recommendRouting(input.runId);
    }
  };
}
