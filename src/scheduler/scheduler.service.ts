import type {
  DatabaseExecutor,
  TransactionPool
} from "../db/database-executor.js";
import { inTransaction } from "../db/database-executor.js";
import { OutboxEventWriterRepository } from "../outbox/outbox-event-writer.repository.js";
import { selectProviderModel } from "../providers/provider-model.policy.js";
import { FailureRecordRepository } from "../reliability/failure-record.repository.js";
import type { ProviderName } from "../types/database.types.js";
import { SchedulerRepository } from "./scheduler.repository.js";

type SchedulerDatabase = DatabaseExecutor & TransactionPool;

export type SchedulerTickResult =
  | { outcome: "enqueued"; schedulerJobId: string; analysisRunId: string }
  | { outcome: "failed"; schedulerJobId: string }
  | { outcome: "idle"; schedulerJobId: null };

export class SchedulerService {
  constructor(
    private readonly database: SchedulerDatabase,
    private readonly realProvidersEnabled = false
  ) {}

  async tick(now = new Date()): Promise<SchedulerTickResult> {
    return inTransaction(this.database, async (client) => {
      const schedules = new SchedulerRepository(client);
      const job = await schedules.claimNextDue(now);
      if (!job) return { outcome: "idle", schedulerJobId: null };
      await client.query("SAVEPOINT scheduler_tick_work");
      try {
        const intervalSeconds = parseInterval(job.schedule_expression);
        if (job.timezone !== "UTC") {
          throw new Error("Phase 12 interval schedules require UTC");
        }
        const requestedProvider = parseRequestedProvider(
          job.request_payload.requestedProvider
        );
        const requestedModel = parseRequestedModel(
          job.request_payload.requestedModel
        );
        const selection = selectProviderModel({
          actorType: "user",
          requestedProvider,
          requestedModel,
          realProvidersEnabled: this.realProvidersEnabled
        });
        const dueAt = job.next_run_at;
        const tickKey =
          `scheduled_analysis:${job.scheduler_job_id}:${dueAt.toISOString()}`;
        const run = await schedules.createOrReuseRun({
          job,
          idempotencyKey: tickKey,
          policy: {
            requestedProvider: selection.provider,
            requestedModel: selection.model
          }
        });
        await new OutboxEventWriterRepository(client).createOrReuse({
          eventKey: `analysis_run.created:${run.analysis_run_id}`,
          eventType: "analysis_run.created",
          eventVersion: 1,
          aggregateType: "analysis_run",
          aggregateId: run.analysis_run_id,
          headers: { queueName: "analysis_run_queue" },
          payload: {
            analysisRunId: run.analysis_run_id,
            startingEntityPathId: run.starting_entity_path_id,
            actorType: "user",
            userId: run.user_id,
            workspaceId: run.workspace_id,
            anonymousSessionId: null
          }
        });
        const nextRunAt = new Date(
          dueAt.getTime() + intervalSeconds * 1_000
        );
        if (
          !(await schedules.advance({
            schedulerJobId: job.scheduler_job_id,
            dueAt,
            nextRunAt,
            analysisRunId: run.analysis_run_id
          }))
        ) {
          throw new Error("Scheduled tick could not advance");
        }
        await client.query("RELEASE SAVEPOINT scheduler_tick_work");
        return {
          outcome: "enqueued",
          schedulerJobId: job.scheduler_job_id,
          analysisRunId: run.analysis_run_id
        };
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT scheduler_tick_work");
        await schedules.pause(job.scheduler_job_id);
        await new FailureRecordRepository(client).createOrReuse({
          queueName: "scheduler_queue",
          messageId:
            `scheduler_tick:${job.scheduler_job_id}:` +
            job.next_run_at.toISOString(),
          aggregateType: "scheduler_job",
          aggregateId: job.scheduler_job_id,
          attemptNumber: 1,
          errorCode: "SCHEDULER_JOB_INVALID",
          errorMessage:
            error instanceof Error ? error.message : "Scheduler tick failed",
          errorDetails: { permanent: true }
        });
        return {
          outcome: "failed",
          schedulerJobId: job.scheduler_job_id
        };
      }
    });
  }

  async drainDue(input: { now?: Date; limit: number }) {
    const results: SchedulerTickResult[] = [];
    for (let index = 0; index < input.limit; index += 1) {
      const result = await this.tick(input.now);
      if (result.outcome === "idle") break;
      results.push(result);
    }
    return results;
  }
}

function parseRequestedProvider(value: unknown): ProviderName | null {
  if (value === undefined || value === null) return null;
  if (
    value === "mock" ||
    value === "openai" ||
    value === "gemini" ||
    value === "claude"
  ) {
    return value;
  }
  throw new Error("Scheduler requestedProvider is invalid");
}

function parseRequestedModel(value: unknown) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.length > 0 && value.length <= 255) {
    return value;
  }
  throw new Error("Scheduler requestedModel is invalid");
}

export function parseInterval(expression: string) {
  const match = /^interval:([1-9]\d*)$/.exec(expression);
  const seconds = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 31_536_000) {
    throw new Error(
      "schedule_expression must be interval:<seconds> between 60 and 31536000"
    );
  }
  return seconds;
}
