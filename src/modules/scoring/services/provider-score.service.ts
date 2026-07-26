import type {
  DatabaseExecutor,
  TransactionPool
} from "../../../common/database/database-executor.js";
import { inTransaction } from "../../../common/database/database-executor.js";
import { ReportAggregationService } from "../../reports/services/report-aggregation.service.js";
import { ReportRepository } from "../../reports/repositories/report.repository.js";
import { calculateProviderScore } from "../../../utils/score-calculators.js";
import { ProviderScoreRepository } from "../repositories/provider-score.repository.js";
import type { ProviderResultCreatedPayload } from "../messages/provider-score-worker.messages.js";
import { SCORING_VERSION } from "../types/score.types.js";
import { requiresScoring } from "../../prompts/policies/prompt-policy.registry.js";

type ScoringDatabase = DatabaseExecutor & TransactionPool;

export type ProviderScoringResult =
  | {
      outcome: "scored";
      providerScoreId: string;
      reportId: string | null;
    }
  | {
      outcome: "noop";
      providerScoreId: string;
      reportId: string | null;
    };

export class ProviderScoringError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ProviderScoringError";
  }
}

export class ProviderScoreService {
  constructor(private readonly database: ScoringDatabase) {}

  async process(
    payload: ProviderResultCreatedPayload
  ): Promise<ProviderScoringResult> {
    return inTransaction(this.database, async (client) => {
      const scores = new ProviderScoreRepository(client);
      const state = await scores.findForUpdate(payload.providerResultId);
      if (!state) {
        throw new ProviderScoringError(
          "PROVIDER_RESULT_NOT_FOUND",
          `Provider result ${payload.providerResultId} does not exist`
        );
      }
      if (
        state.result_status !== "valid" ||
        state.validated_response === null ||
        !requiresScoring(state.prompt_type) ||
        state.provider_job_status !== "succeeded"
      ) {
        throw new ProviderScoringError(
          "PROVIDER_RESULT_NOT_SCORABLE",
          "Only valid results from succeeded provider and prompt jobs can be scored"
        );
      }

      const calculation = calculateProviderScore({
        promptType: state.prompt_type,
        provider: state.provider,
        model: state.model,
        validatedResponse: state.validated_response
      });
      const score = await scores.createOrReuse({
        providerResultId: state.provider_result_id,
        scoringVersion: SCORING_VERSION,
        metricType: calculation.metricType,
        score: calculation.score,
        components: calculation.components
      });

      const run = await scores.lockAnalysisRun(state.analysis_run_id);
      if (!run) {
        throw new ProviderScoringError(
          "ANALYSIS_RUN_NOT_FOUND",
          `Analysis run ${state.analysis_run_id} does not exist`
        );
      }
      const report = await new ReportAggregationService(
        new ReportRepository(client)
      ).createIfReady(state.analysis_run_id);

      return {
        outcome: score.created ? "scored" : "noop",
        providerScoreId: score.row.provider_score_id,
        reportId:
          report.outcome === "snapshot" ? report.reportId : null
      };
    });
  }
}
