import { createHash } from "node:crypto";
import type {
  DatabaseExecutor,
  TransactionPool
} from "../../../common/database/database-executor.js";
import { inTransaction } from "../../../common/database/database-executor.js";
import type {
  DomainCategoryClassificationJobRow,
  JsonObject
} from "../../../common/types/database.types.js";
import { OutboxEventWriterRepository } from "../../outbox/repositories/outbox-event-writer.repository.js";
import { ProviderJobRepository } from "../../providers/repositories/provider-job.repository.js";
import { validateFrozenProviderModel } from "../../providers/policies/provider-model.policy.js";
import type { ClassificationJobCreatedPayload } from "../messages/classification-worker.messages.js";

type ClassificationPlanningDatabase = DatabaseExecutor & TransactionPool;

export class ClassificationPlanningService {
  constructor(
    private readonly database: ClassificationPlanningDatabase,
    private readonly realProvidersEnabled = false
  ) {}

  async plan(payload: ClassificationJobCreatedPayload) {
    return inTransaction(this.database, async (client) => {
      const result =
        await client.query<DomainCategoryClassificationJobRow>(
          `
            SELECT *
            FROM domain_category_classification_jobs
            WHERE domain_category_classification_job_id = $1
            FOR UPDATE
          `,
          [payload.classificationJobId]
        );
      const job = result.rows[0];
      if (!job) throw new PermanentClassificationError(
        "CLASSIFICATION_JOB_NOT_FOUND",
        "Classification job does not exist"
      );
      if (job.status !== "queued") return { outcome: "noop" as const };

      const renderedPrompt = renderClassificationPrompt(job.input_payload);
      const selection = validateFrozenProviderModel(
        {
          provider: job.classifier_provider,
          model: job.classifier_model,
          modelProfileVersion: job.model_profile_version
        },
        this.realProvidersEnabled
      );
      const requestPayload = {
        classificationJobId: job.domain_category_classification_job_id,
        promptType: "domain_category_classification",
        promptVersion: job.prompt_version,
        responseContractVersion: job.response_contract_version,
        renderedPrompt,
        classificationContext: job.input_payload
      };
      const requestHash = createHash("sha256")
        .update(JSON.stringify(requestPayload))
        .digest("hex");
      await client.query(
        `
          UPDATE domain_category_classification_jobs
          SET status = 'processing',
              rendered_prompt = $2,
              started_at = COALESCE(started_at, now()),
              updated_at = now()
          WHERE domain_category_classification_job_id = $1
            AND status = 'queued'
        `,
        [job.domain_category_classification_job_id, renderedPrompt]
      );
      const providerJob =
        await new ProviderJobRepository(client).createOrReuseClassification({
          classificationJobId:
            job.domain_category_classification_job_id,
          provider: selection.provider,
          model: selection.model,
          responseContractVersion: job.response_contract_version,
          providerInstructionProfile:
            selection.providerInstructionProfile,
          modelProfileVersion: selection.modelProfileVersion,
          structuredOutputMode: selection.preferredStructuredOutputMode,
          requestHash,
          requestPayload
        });
      await new OutboxEventWriterRepository(client).createOrReuse({
        eventKey: `provider_job.created:${providerJob.provider_job_id}`,
        eventType: "provider_job.created",
        eventVersion: 1,
        aggregateType: "provider_job",
        aggregateId: providerJob.provider_job_id,
        headers: { queueName: selection.queueName },
        payload: { providerJobId: providerJob.provider_job_id }
      });
      return {
        outcome: "enqueued" as const,
        providerJobId: providerJob.provider_job_id
      };
    });
  }
}

function renderClassificationPrompt(payload: JsonObject) {
  const domain = payload.domain;
  const candidates = payload.candidates;
  if (
    !domain ||
    typeof domain !== "object" ||
    Array.isArray(domain) ||
    typeof domain.name !== "string" ||
    !Array.isArray(candidates) ||
    candidates.length === 0
  ) {
    throw new PermanentClassificationError(
      "CLASSIFICATION_CONTEXT_INVALID",
      "Frozen classification context is invalid"
    );
  }
  const candidateLines = candidates.map((candidate, index) => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate) ||
      typeof candidate.categoryId !== "string" ||
      typeof candidate.categoryName !== "string"
    ) {
      throw new PermanentClassificationError(
        "CLASSIFICATION_CONTEXT_INVALID",
        "Frozen classification candidate is invalid"
      );
    }
    return `${index + 1}. id=${candidate.categoryId}; name=${candidate.categoryName}`;
  });
  return `You are a website taxonomy classification analyst.

Website hostname: ${domain.name}
Candidate categories (authoritative database IDs):
${candidateLines.join("\n")}

Tasks:
1. Select only candidates that genuinely describe the website's business.
2. Rank accepted matches contiguously from 1, strongest first.
3. Return zero matches when the evidence is insufficient.
4. Never create, rename or substitute a category and never output an ID not listed above.
5. Confidence must be a finite number from 0 to 1; reason must be concise and nonblank.
6. Do not claim live browsing, private data, invented URLs or citations.

Return only strict JSON with no markdown or extra keys:
{"prompt_type":"domain_category_classification","contract_version":"domain-category-classification-response-v1","matches":[{"category_id":"positive database ID","rank":1,"confidence":0.0,"reason":"bounded reason"}],"summary":"bounded summary"}`;
}

export class PermanentClassificationError extends Error {
  readonly permanent = true;

  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PermanentClassificationError";
  }
}
