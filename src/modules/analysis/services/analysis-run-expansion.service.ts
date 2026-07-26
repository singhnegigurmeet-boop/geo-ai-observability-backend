import type {
  DatabaseExecutor,
  TransactionPool
} from "../../../common/database/database-executor.js";
import { inTransaction } from "../../../common/database/database-executor.js";
import { EntityPathRepository } from "../../hierarchy/repositories/entity-path.repository.js";
import { OutboxEventWriterRepository } from "../../outbox/repositories/outbox-event-writer.repository.js";
import type { EntityPathRow } from "../../../common/types/database.types.js";
import { AnalysisRunExpansionRepository } from "../repositories/analysis-run-expansion.repository.js";
import { AnalysisRunItemRepository } from "../repositories/analysis-run-item.repository.js";
import { ReportRepository } from "../../reports/repositories/report.repository.js";
import { ReportOutcomeService } from "../../reports/services/report-outcome.service.js";
import type { AnalysisRunCreatedPayload } from "../messages/analysis-run-worker.messages.js";
import { DomainCategoryClassificationRepository } from "../repositories/domain-category-classification.repository.js";
import { resolveClassificationModel } from "../../providers/policies/provider-model.policy.js";
import type { ProviderName } from "../../../common/types/database.types.js";

type ExpansionDatabase = DatabaseExecutor & TransactionPool;

export type AnalysisRunExpansionResult =
  | { outcome: "expanded"; itemCount: number }
  | { outcome: "empty"; itemCount: 0 }
  | { outcome: "classification_pending"; itemCount: 0 }
  | { outcome: "noop"; itemCount: 0 };

export class PermanentAnalysisRunError extends Error {
  readonly permanent = true;

  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "PermanentAnalysisRunError";
  }
}

export class AnalysisRunExpansionService {
  constructor(
    private readonly database: ExpansionDatabase,
    private readonly classifier: {
      provider: ProviderName;
      model: string;
      realProvidersEnabled: boolean;
    } = {
      provider: "mock",
      model: "mock-fast",
      realProvidersEnabled: false
    }
  ) {}

  async expand(
    payload: AnalysisRunCreatedPayload
  ): Promise<AnalysisRunExpansionResult> {
    return inTransaction(this.database, async (client) => {
      const expansion = new AnalysisRunExpansionRepository(client);
      const run = await expansion.findRunForUpdate(payload.analysisRunId);
      if (!run) {
        throw new PermanentAnalysisRunError(
          "ANALYSIS_RUN_NOT_FOUND",
          `Analysis run ${payload.analysisRunId} does not exist`
        );
      }
      if (run.status !== "queued" && run.status !== "processing") {
        return { outcome: "noop", itemCount: 0 };
      }
      if (await expansion.hasItems(run.analysis_run_id)) {
        return { outcome: "noop", itemCount: 0 };
      }
      const startingPath = await new EntityPathRepository(
        client
      ).findActiveValidated(
        run.starting_entity_path_id
      );
      if (!startingPath) {
        throw new PermanentAnalysisRunError(
          "STARTING_ENTITY_PATH_INVALID",
          "Starting entity path is inactive or no longer has an active hierarchy chain"
        );
      }

      const breadth = run.user_id && run.workspace_id ? 5 : 3;
      if (startingPath.path_type === "domain") {
        const classifications =
          new DomainCategoryClassificationRepository(client);
        const candidates = await classifications.unresolvedCandidates(
          run.analysis_run_id,
          startingPath.domain_id
        );
        if (candidates.length > 0) {
          const classifier = resolveClassificationModel({
            ...this.classifier
          });
          const domainName = run.request_payload.domain;
          if (typeof domainName !== "string") {
            throw new PermanentAnalysisRunError(
              "CANONICAL_DOMAIN_MISSING",
              "Analysis run has no canonical domain"
            );
          }
          const classification = await classifications.createOrReuse({
            analysisRunId: run.analysis_run_id,
            domainId: startingPath.domain_id,
            normalizedDomain: domainName,
            candidates,
            classifier
          });
          if (
            classification.row.status === "queued" ||
            classification.row.status === "processing"
          ) {
            if (classification.created) {
              await new OutboxEventWriterRepository(client).createOrReuse({
                eventKey:
                  `domain_category_classification.created:${classification.row.domain_category_classification_job_id}`,
                eventType: "domain_category_classification.created",
                eventVersion: 1,
                aggregateType: "domain_category_classification",
                aggregateId:
                  classification.row.domain_category_classification_job_id,
                headers: {
                  queueName: "domain_category_classification_queue"
                },
                payload: {
                  classificationJobId:
                    classification.row
                      .domain_category_classification_job_id
                }
              });
            }
            await expansion.markProcessing(run.analysis_run_id);
            return { outcome: "classification_pending", itemCount: 0 };
          }
        }
      }
      const selections =
        startingPath.path_type === "domain"
          ? await expansion.listRequestedCategoryChildren(
              run.analysis_run_id,
              startingPath.domain_id,
              breadth
            )
          : await selectChildren(expansion, startingPath, breadth);
      if (selections.length === 0) {
        const classificationStatus =
          startingPath.path_type === "domain"
            ? await expansion.latestClassificationStatus(run.analysis_run_id)
            : null;
        if (
          classificationStatus === "invalid" ||
          classificationStatus === "failed"
        ) {
          await expansion.markClassificationFailed(run.analysis_run_id);
          await new ReportOutcomeService(
            new ReportRepository(client)
          ).createFailedEmpty({
            analysisRunId: run.analysis_run_id,
            errorCode: "CLASSIFICATION_EVIDENCE_UNAVAILABLE",
            summary:
              "No valid domain category classification evidence was available."
          });
          return { outcome: "empty", itemCount: 0 };
        }
        await expansion.markNoExpansionChildren(
          run.analysis_run_id,
          `No active ${nextHierarchyLevel(startingPath.path_type)} relationships exist for the starting path`
        );
        const noMatchingCategory =
          startingPath.path_type === "domain" &&
          classificationStatus === "completed_empty";
        await new ReportOutcomeService(
          new ReportRepository(client)
        ).createCompletedEmpty({
          analysisRunId: run.analysis_run_id,
          startingEntityPathId: run.starting_entity_path_id,
          reason: noMatchingCategory
            ? "no_matching_category"
            : "no_applicable_analysis_item",
          summary: noMatchingCategory
            ? "The classifier found no matching category in the frozen candidate set."
            : "No eligible analysis targets were configured for this path.",
          nextAction: noMatchingCategory
            ? "Submit a different active category selection if broader classification is required."
            : "Configure an active child relationship for the selected hierarchy path."
        });
        return { outcome: "empty", itemCount: 0 };
      }

      const paths = new EntityPathRepository(client);
      const items = new AnalysisRunItemRepository(client);
      const outbox = new OutboxEventWriterRepository(client);
      for (const [ordinal, selection] of selections.entries()) {
        const path =
          startingPath.path_type === "use_context"
            ? startingPath
            : await paths.findOrCreate(selection);
        const item = await items.createOrReuse({
          analysisRunId: run.analysis_run_id,
          entityPathId: path.entity_path_id,
          ordinal
        });
        await outbox.createOrReuse({
          eventKey:
            `analysis_run_item.created:${item.analysis_run_item_id}`,
          eventType: "analysis_run_item.created",
          eventVersion: 1,
          aggregateType: "analysis_run_item",
          aggregateId: item.analysis_run_item_id,
          headers: { queueName: "analysis_run_item_queue" },
          payload: {
            analysisRunItemId: item.analysis_run_item_id
          }
        });
      }

      await expansion.markProcessing(run.analysis_run_id);
      return { outcome: "expanded", itemCount: selections.length };
    });
  }
}

async function selectChildren(
  repository: AnalysisRunExpansionRepository,
  path: EntityPathRow,
  breadth: number
) {
  switch (path.path_type) {
    case "domain":
      return repository.listActiveCategoryChildren(path.domain_id, breadth);
    case "category":
      return repository.listActiveBrandChildren(path, breadth);
    case "brand":
      return repository.listActiveProductChildren(path, breadth);
    case "product":
      return repository.listActiveUseContextChildren(path, breadth);
    case "use_context":
      return [
        {
          domainId: path.domain_id,
          categoryId: path.category_id,
          brandId: path.brand_id,
          productId: path.product_id,
          useContextId: path.use_context_id,
          pathType: path.path_type
        }
      ];
  }
}

function nextHierarchyLevel(pathType: EntityPathRow["path_type"]) {
  switch (pathType) {
    case "domain":
      return "domain-category";
    case "category":
      return "category-brand";
    case "brand":
      return "brand-product";
    case "product":
      return "product-use-context";
    case "use_context":
      return "deeper";
  }
}
