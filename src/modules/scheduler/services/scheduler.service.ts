import type {
  DatabaseExecutor,
  TransactionPool
} from "../../../common/database/database-executor.js";
import { inTransaction } from "../../../common/database/database-executor.js";
import { ApplicationError } from "../../../common/errors/application-error.js";
import { EntityPathRepository } from "../../hierarchy/repositories/entity-path.repository.js";
import { OutboxEventWriterRepository } from "../../outbox/repositories/outbox-event-writer.repository.js";
import {
  parseProviderModels,
  resolveDiscoveryModel,
  resolveProviderModelSet,
} from "../../providers/policies/provider-model.policy.js";
import { FailureRecordRepository } from "../../reliability/repositories/failure-record.repository.js";
import { SchedulerRepository } from "../repositories/scheduler.repository.js";
import { WorkspaceAuthorizationService } from "../../workspaces/services/workspace-authorization.service.js";
import { WorkspaceMemberRepository } from "../../workspaces/repositories/workspace-member.repository.js";
import { PROMPT_POLICY_VERSION } from "../../prompts/policies/prompt-policy.registry.js";
import { PreAnalysisRequestRepository } from "../../discovery/repositories/pre-analysis-request.repository.js";
import { AnalysisRunRequestedCategoryRepository } from "../../analysis/repositories/analysis-run-requested-category.repository.js";
import { hashCanonical } from "../../analysis/services/canonical-analysis-planner.service.js";
import {
  HIERARCHY_DISCOVERY_CONTRACT_VERSIONS,
  HIERARCHY_DISCOVERY_POLICY_VERSION,
  HIERARCHY_DISCOVERY_PROMPT_VERSIONS
} from "../../providers/contracts/provider-response.contracts.js";
import type { ProviderName, WorkspaceRole } from "../../../common/types/database.types.js";

type SchedulerDatabase = DatabaseExecutor & TransactionPool;

export type SchedulerTickResult =
  | { outcome: "enqueued"; schedulerJobId: string; preAnalysisRequestId: string; analysisRunId: null }
  | { outcome: "failed"; schedulerJobId: string }
  | { outcome: "idle"; schedulerJobId: null };

export class SchedulerService {
  constructor(
    private readonly database: SchedulerDatabase,
    private readonly realProvidersEnabled = false,
    private readonly discovery: {
      provider: ProviderName;
      model: string;
      fallbackProvider: ProviderName | null;
      fallbackModel: string | null;
    } = { provider: "mock", model: "mock-fast", fallbackProvider: null, fallbackModel: null }
  ) {}

  async tick(now = new Date()): Promise<SchedulerTickResult> {
    return inTransaction(this.database, async (client) => {
      const schedules = new SchedulerRepository(client);
      const job = await schedules.claimNextDue(now);
      if (!job) return { outcome: "idle", schedulerJobId: null };
      await client.query("SAVEPOINT scheduler_tick_work");
      try {
        const intervalSeconds = parseInterval(job.schedule_expression);
        let workspaceRole: WorkspaceRole;
        try {
          const authorization = new WorkspaceAuthorizationService(
            new WorkspaceMemberRepository(client)
          );
          const membership = await authorization.requireMembership(
            job.created_by_user_id,
            job.workspace_id
          );
          authorization.requireMutationRole(membership);
          workspaceRole = membership.role;
        } catch (error) {
          if (error instanceof ApplicationError) {
            throw new SchedulerValidationError(
              "SCHEDULER_AUTHORIZATION_NO_LONGER_VALID",
              "Scheduler owner is no longer active or authorized"
            );
          }
          throw error;
        }
        if (
          !(await new EntityPathRepository(client).findActiveValidated(
            job.starting_entity_path_id
          ))
        ) {
          throw new SchedulerValidationError(
            "HIERARCHY_NO_LONGER_VALID",
            "Scheduled hierarchy path is no longer active and valid"
          );
        }
        if (job.timezone !== "UTC") {
          throw new SchedulerValidationError(
            "SCHEDULER_TIMEZONE_INVALID",
            "Interval schedules require UTC"
          );
        }
        if (job.prompt_policy_version !== PROMPT_POLICY_VERSION) {
          throw new SchedulerValidationError(
            "PROMPT_POLICY_VERSION_UNAVAILABLE",
            "Scheduled prompt policy version is no longer executable"
          );
        }
        const selection = resolveProviderModelSet({
          actorType: "user",
          providerModels: parseProviderModels(
            job.request_payload.providerModels
          ),
          promptDepth: job.prompt_depth,
          realProvidersEnabled: this.realProvidersEnabled
        });
        const categoryIds =
          await schedules.activeRequestedCategoryIds(job.scheduler_job_id);
        const expectedCategoryCount = await client.query<{ count: string }>(
          `
            SELECT count(*)::bigint AS count
            FROM scheduler_job_requested_categories
            WHERE scheduler_job_id = $1
          `,
          [job.scheduler_job_id]
        );
        if (
          categoryIds.length === 0 ||
          categoryIds.length !== Number(expectedCategoryCount.rows[0]?.count ?? 0)
        ) {
          throw new SchedulerValidationError(
            "SCHEDULED_CATEGORY_SET_INVALID",
            "One or more frozen scheduled categories are inactive"
          );
        }
        const dueAt = job.next_run_at;
        const tickKey =
          `scheduled_analysis:${job.scheduler_job_id}:${dueAt.toISOString()}`;
        const categorySelection =
          job.category_selection_mode === "selected"
            ? { mode: "selected" as const, categoryIds }
            : { mode: "all" as const };
        const primary = resolveDiscoveryModel({
          provider: this.discovery.provider,
          model: this.discovery.model,
          realProvidersEnabled: this.realProvidersEnabled
        });
        const fallback = this.discovery.fallbackProvider && this.discovery.fallbackModel
          ? resolveDiscoveryModel({ provider: this.discovery.fallbackProvider, model: this.discovery.fallbackModel, realProvidersEnabled: this.realProvidersEnabled })
          : null;
        const canonicalRequest = {
          domain: job.normalized_domain,
          categoryId: job.category_id,
          brandId: job.brand_id,
          productId: job.product_id,
          useContextId: job.use_context_id,
          categorySelection: { mode: categorySelection.mode, categoryIds },
          promptDepth: job.prompt_depth,
          providerModels: selection.map(({ provider, model }) => ({ provider, model })),
          schedulerJobId: job.scheduler_job_id,
          scheduledDueAt: dueAt.toISOString(),
          discoveryProfile: {
            ...primary,
            fallback: fallback ? { provider: fallback.provider, model: fallback.model, modelProfileVersion: fallback.modelProfileVersion } : null,
            policyVersion: HIERARCHY_DISCOVERY_POLICY_VERSION,
            promptVersions: HIERARCHY_DISCOVERY_PROMPT_VERSIONS,
            contractVersions: HIERARCHY_DISCOVERY_CONTRACT_VERSIONS
          }
        };
        const canonicalRequestHash = hashCanonical(canonicalRequest);
        const requests = new PreAnalysisRequestRepository(client);
        const owner = { actorType: "user" as const, anonymousSessionId: null, userId: job.created_by_user_id, workspaceId: job.workspace_id, workspaceRole };
        let preAnalysisRequest = await requests.findByIdempotencyKey(tickKey);
        if (!preAnalysisRequest) {
          preAnalysisRequest = await requests.create({
            idempotencyKey: tickKey,
            owner,
            domainId: job.domain_id,
            startingEntityPathId: job.starting_entity_path_id,
            categorySelectionMode: job.category_selection_mode,
            promptDepth: job.prompt_depth,
            source: "scheduled",
            requestPayload: canonicalRequest,
            canonicalRequestHash,
            discoveryCompatibilityHash: hashCanonical({ domain: job.normalized_domain, categoryIds, profile: canonicalRequest.discoveryProfile })
          }) ?? await requests.findByIdempotencyKey(tickKey);
        }
        if (!preAnalysisRequest || preAnalysisRequest.canonical_request_hash !== canonicalRequestHash) {
          throw new Error("Existing scheduled request violates stable tick identity");
        }
        await new AnalysisRunRequestedCategoryRepository(client).createOrReuseForRequest(preAnalysisRequest.pre_analysis_request_id, categoryIds);
        await new OutboxEventWriterRepository(client).createOrReuse({
          eventKey: `pre_analysis_request.accepted:${preAnalysisRequest.pre_analysis_request_id}`,
          eventType: "pre_analysis_request.accepted",
          eventVersion: 1,
          aggregateType: "pre_analysis_request",
          aggregateId: preAnalysisRequest.pre_analysis_request_id,
          headers: { queueName: "domain_hierarchy_discovery_queue" },
          payload: { preAnalysisRequestId: preAnalysisRequest.pre_analysis_request_id }
        });
        const nextRunAt = new Date(
          dueAt.getTime() + intervalSeconds * 1_000
        );
        if (
          !(await schedules.advance({
            schedulerJobId: job.scheduler_job_id,
            dueAt,
            nextRunAt,
            preAnalysisRequestId: preAnalysisRequest.pre_analysis_request_id
          }))
        ) {
          throw new Error("Scheduled tick could not advance");
        }
        await client.query("RELEASE SAVEPOINT scheduler_tick_work");
        return {
          outcome: "enqueued",
          schedulerJobId: job.scheduler_job_id,
          preAnalysisRequestId: preAnalysisRequest.pre_analysis_request_id,
          analysisRunId: null
        };
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT scheduler_tick_work");
        if (
          !(error instanceof SchedulerValidationError) &&
          !(
            error &&
            typeof error === "object" &&
            "permanent" in error &&
            error.permanent === true
          )
        ) {
          throw error;
        }
        await schedules.pause(job.scheduler_job_id);
        await new FailureRecordRepository(client).createOrReuse({
          queueName: "scheduler_queue",
          messageId:
            `scheduler_tick:${job.scheduler_job_id}:` +
            job.next_run_at.toISOString(),
          aggregateType: "scheduler_job",
          aggregateId: job.scheduler_job_id,
          attemptNumber: 1,
          errorCode:
            error instanceof SchedulerValidationError
              ? error.code
              : "SCHEDULER_JOB_INVALID",
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

class SchedulerValidationError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "SchedulerValidationError";
  }
}

export function parseInterval(expression: string) {
  const match = /^interval:([1-9]\d*)$/.exec(expression);
  const seconds = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 31_536_000) {
    throw new SchedulerValidationError(
      "SCHEDULE_EXPRESSION_INVALID",
      "schedule_expression must be interval:<seconds> between 60 and 31536000"
    );
  }
  return seconds;
}
