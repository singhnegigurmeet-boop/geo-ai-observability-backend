import { createHash } from "node:crypto";
import type {
  DatabaseExecutor,
  TransactionPool
} from "../../../common/database/database-executor.js";
import { inTransaction } from "../../../common/database/database-executor.js";
import type {
  DomainCategoryClassificationJobRow
} from "../../../common/types/database.types.js";
import { OutboxEventWriterRepository } from "../../outbox/repositories/outbox-event-writer.repository.js";
import { ProviderJobRepository } from "../../providers/repositories/provider-job.repository.js";
import { validateFrozenClassificationModel } from "../../providers/policies/provider-model.policy.js";
import {
  DOMAIN_CATEGORY_CLASSIFICATION_CONTRACT_VERSION,
  DOMAIN_CATEGORY_CLASSIFICATION_PROMPT_VERSION
} from "../../providers/contracts/provider-response.contracts.js";
import type { ClassificationJobCreatedPayload } from "../messages/classification-worker.messages.js";
import {
  authoritativeClassificationContext,
  ClassificationIntegrityError,
  loadAuthoritativeClassificationState
} from "./classification-authority.service.js";

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

      const authority = await loadAuthoritativeClassificationState(
        client,
        job.analysis_run_id
      );
      let context;
      try {
        context = authoritativeClassificationContext({
          job,
          ...authority
        });
      } catch (error) {
        if (error instanceof ClassificationIntegrityError) {
          throw new PermanentClassificationError(error.code, error.message);
        }
        throw error;
      }
      if (
        job.prompt_version !==
          DOMAIN_CATEGORY_CLASSIFICATION_PROMPT_VERSION ||
        job.response_contract_version !==
          DOMAIN_CATEGORY_CLASSIFICATION_CONTRACT_VERSION
      ) {
        throw new PermanentClassificationError(
          "CLASSIFICATION_CONTRACT_UNSUPPORTED",
          "Frozen classification prompt or response contract is unsupported"
        );
      }
      const selection = validateFrozenClassificationModel(
        {
          provider: job.classifier_provider,
          model: job.classifier_model,
          modelProfileVersion: job.model_profile_version,
          providerInstructionProfile:
            job.provider_instruction_profile,
          structuredOutputMode: job.structured_output_mode
        },
        this.realProvidersEnabled
      );
      const renderedPrompt = renderClassificationPrompt({
        normalizedDomain: authority.normalizedDomain!,
        candidates: context.candidates,
        promptVersion: job.prompt_version,
        responseContractVersion: job.response_contract_version
      });
      const requestPayload = {
        classificationJobId: job.domain_category_classification_job_id,
        promptType: "domain_category_classification",
        promptVersion: job.prompt_version,
        responseContractVersion: job.response_contract_version,
        renderedPrompt,
        classificationContext: context.inputPayload
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
            job.provider_instruction_profile,
          modelProfileVersion: job.model_profile_version,
          structuredOutputMode: job.structured_output_mode,
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

export function renderClassificationPrompt(input: {
  normalizedDomain: string;
  candidates: readonly { categoryId: string; categoryName: string }[];
  promptVersion: string;
  responseContractVersion: string;
}) {
  const candidateLines = input.candidates.map((candidate, index) => {
    return `${index + 1}. id=${candidate.categoryId}; name=${candidate.categoryName}`;
  });
  return `You are a website taxonomy classification analyst.

Prompt type: domain_category_classification
Prompt version: ${input.promptVersion}
Response contract version: ${input.responseContractVersion}
Website hostname: ${input.normalizedDomain}
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
{"prompt_type":"domain_category_classification","contract_version":"${input.responseContractVersion}","matches":[{"category_id":"positive database ID","rank":1,"confidence":0.0,"reason":"bounded reason"}],"summary":"bounded summary"}`;
}

export class PermanentClassificationError extends Error {
  readonly permanent = true;

  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PermanentClassificationError";
  }
}
