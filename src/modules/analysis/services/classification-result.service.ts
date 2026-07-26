import type {
  DatabaseExecutor,
  TransactionPool
} from "../../../common/database/database-executor.js";
import { inTransaction } from "../../../common/database/database-executor.js";
import type {
  JsonObject,
  ProviderResultStatus
} from "../../../common/types/database.types.js";
import { OutboxEventWriterRepository } from "../../outbox/repositories/outbox-event-writer.repository.js";
import { domainCategoryClassificationResponseSchema } from "../../providers/contracts/provider-response.contracts.js";
import type { ClassificationResultCreatedPayload } from "../messages/classification-result-worker.messages.js";

type ClassificationResultDatabase = DatabaseExecutor & TransactionPool;

type ClassificationResultState = {
  provider_result_id: string;
  result_status: ProviderResultStatus;
  validated_response: JsonObject | null;
  domain_category_classification_job_id: string;
  classification_status: string;
  analysis_run_id: string;
  domain_id: string;
};

export class ClassificationResultService {
  constructor(private readonly database: ClassificationResultDatabase) {}

  async process(payload: ClassificationResultCreatedPayload) {
    return inTransaction(this.database, async (client) => {
      const stateResult = await client.query<ClassificationResultState>(
        `
          SELECT
            result.provider_result_id,
            result.status AS result_status,
            result.validated_response,
            classification.domain_category_classification_job_id,
            classification.status AS classification_status,
            classification.analysis_run_id,
            classification.domain_id
          FROM provider_results AS result
          JOIN provider_jobs AS provider_job
            ON provider_job.provider_job_id = result.provider_job_id
           AND provider_job.job_kind = 'domain_category_classification'
          JOIN domain_category_classification_jobs AS classification
            ON classification.domain_category_classification_job_id =
               provider_job.classification_job_id
          WHERE result.provider_result_id = $1
          FOR UPDATE OF classification
        `,
        [payload.providerResultId]
      );
      const state = stateResult.rows[0];
      if (!state) {
        throw new PermanentClassificationResultError(
          "CLASSIFICATION_RESULT_NOT_FOUND",
          "Classification provider result does not exist"
        );
      }
      if (state.classification_status !== "processing") {
        return { outcome: "noop" as const };
      }
      if (
        state.result_status !== "valid" ||
        state.validated_response === null
      ) {
        await terminalize(
          client,
          state.domain_category_classification_job_id,
          "invalid",
          "INVALID_CLASSIFICATION_EVIDENCE",
          "Classifier output failed validation"
        );
        await requeueRun(client, state);
        return { outcome: "invalid" as const, relationshipCount: 0 };
      }
      const response = domainCategoryClassificationResponseSchema.safeParse(
        state.validated_response
      );
      if (!response.success) {
        await terminalize(
          client,
          state.domain_category_classification_job_id,
          "invalid",
          "INVALID_CLASSIFICATION_EVIDENCE",
          "Stored classification response failed its frozen contract"
        );
        await requeueRun(client, state);
        return { outcome: "invalid" as const, relationshipCount: 0 };
      }
      for (const match of response.data.matches) {
        await client.query(
          `
            INSERT INTO domain_categories (
              domain_id, category_id, is_active, source,
              classification_provider_result_id, classification_rank,
              classification_confidence, classified_at
            )
            SELECT $1, category.category_id, true, 'llm_classification',
                   $3, $4, $5, now()
            FROM categories AS category
            JOIN analysis_run_requested_categories AS requested
              ON requested.category_id = category.category_id
             AND requested.analysis_run_id = $6
            WHERE category.category_id = $2 AND category.is_active
            ON CONFLICT (domain_id, category_id) DO NOTHING
          `,
          [
            state.domain_id,
            match.category_id,
            state.provider_result_id,
            match.rank,
            match.confidence,
            state.analysis_run_id
          ]
        );
      }
      await terminalize(
        client,
        state.domain_category_classification_job_id,
        response.data.matches.length === 0 ? "completed_empty" : "completed",
        null,
        null
      );
      await requeueRun(client, state);
      return {
        outcome:
          response.data.matches.length === 0
            ? ("completed_empty" as const)
            : ("completed" as const),
        relationshipCount: response.data.matches.length
      };
    });
  }
}

async function terminalize(
  database: DatabaseExecutor,
  classificationJobId: string,
  status: "completed" | "completed_empty" | "invalid",
  errorCode: string | null,
  errorMessage: string | null
) {
  await database.query(
    `
      UPDATE domain_category_classification_jobs
      SET status = $2,
          error_code = $3,
          error_message = $4,
          completed_at = now(),
          updated_at = now()
      WHERE domain_category_classification_job_id = $1
        AND status = 'processing'
    `,
    [classificationJobId, status, errorCode, errorMessage]
  );
}

async function requeueRun(
  database: DatabaseExecutor,
  state: ClassificationResultState
) {
  await new OutboxEventWriterRepository(database).createOrReuse({
    eventKey:
      `analysis_run.classification_completed:${state.analysis_run_id}:${state.domain_category_classification_job_id}`,
    eventType: "analysis_run.created",
    eventVersion: 1,
    aggregateType: "analysis_run",
    aggregateId: state.analysis_run_id,
    headers: { queueName: "analysis_run_queue" },
    payload: { analysisRunId: state.analysis_run_id }
  });
}

export class PermanentClassificationResultError extends Error {
  readonly permanent = true;

  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PermanentClassificationResultError";
  }
}
