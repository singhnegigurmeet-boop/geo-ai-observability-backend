import { PROVIDERS } from "../../../config/constants.js";
import type { AnalysisDiffsRepository } from "../repositories/analysis-diffs.repository.js";
import type { AnalysisRunsRepository } from "../../analysis/repositories/analysis-runs.repository.js";
import type { ProviderSnapshotsRepository } from "../../providers/repositories/provider-snapshots.repository.js";
import type { VisibilityScoresRepository } from "../../visibility/repositories/visibility-scores.repository.js";
import type {
  AnalysisDiffInput,
  AnalysisDiffRow,
  AnalysisDiffSeverity,
  ProviderSnapshotRow
} from "../../../types/database.types.js";
import type { ProviderName } from "../../../config/constants.js";

type DiffEngineServiceDependencies = {
  analysisDiffsRepository: AnalysisDiffsRepository;
  analysisRunsRepository: AnalysisRunsRepository;
  providerSnapshotsRepository: ProviderSnapshotsRepository;
  visibilityScoresRepository: VisibilityScoresRepository;
};

type ProviderState = {
  found: boolean;
  bestRank: number | null;
  totalMentions: number;
};

const DIFF_TOP_K_VALUES = new Set([5, 10, 50]);

export class DiffEngineService {
  constructor(private readonly dependencies: DiffEngineServiceDependencies) {}

  async calculateAndStoreDiffs(domainId: number, analysisRunId: number) {
    const previousRun = await this.dependencies.analysisRunsRepository.findPreviousSuccessfulRun(
      domainId,
      analysisRunId
    );

    if (!previousRun) {
      return [];
    }

    const currentVisibility = await this.dependencies.visibilityScoresRepository.findVisibilityScoreByRunId(
      analysisRunId
    );
    const previousVisibility = await this.dependencies.visibilityScoresRepository.findVisibilityScoreByRunId(
      previousRun.analysis_run_id
    );

    if (!currentVisibility || !previousVisibility) {
      return [];
    }

    const currentSnapshots = await this.dependencies.providerSnapshotsRepository.findProviderSnapshotsByRunId(
      analysisRunId
    );
    const previousSnapshots = await this.dependencies.providerSnapshotsRepository.findProviderSnapshotsByRunId(
      previousRun.analysis_run_id
    );

    const diffInputs: AnalysisDiffInput[] = [
      ...this.buildVisibilityDiffs(
        domainId,
        analysisRunId,
        previousRun.analysis_run_id,
        previousVisibility,
        currentVisibility
      ),
      ...this.buildProviderDiffs(
        domainId,
        analysisRunId,
        previousRun.analysis_run_id,
        previousSnapshots,
        currentSnapshots
      )
    ];

    const diffs: AnalysisDiffRow[] = [];

    for (const diffInput of diffInputs) {
      diffs.push(await this.dependencies.analysisDiffsRepository.insertAnalysisDiff(diffInput));
    }

    return diffs;
  }

  private buildVisibilityDiffs(
    domainId: number,
    analysisRunId: number,
    previousAnalysisRunId: number,
    previousVisibility: { overall_geo_score: number },
    currentVisibility: { overall_geo_score: number }
  ): AnalysisDiffInput[] {
    const previousScore = Number(previousVisibility.overall_geo_score);
    const currentScore = Number(currentVisibility.overall_geo_score);
    const change = Number((currentScore - previousScore).toFixed(2));

    if (change >= 0) {
      return [];
    }

    return [
      {
        domainId,
        analysisRunId,
        previousAnalysisRunId,
        diffType: "visibility_score_dropped",
        provider: null,
        oldValue: { overall_geo_score: previousScore },
        newValue: { overall_geo_score: currentScore, change },
        severity: this.getScoreDropSeverity(Math.abs(change))
      }
    ];
  }

  private buildProviderDiffs(
    domainId: number,
    analysisRunId: number,
    previousAnalysisRunId: number,
    previousSnapshots: ProviderSnapshotRow[],
    currentSnapshots: ProviderSnapshotRow[]
  ): AnalysisDiffInput[] {
    const diffs: AnalysisDiffInput[] = [];

    for (const provider of PROVIDERS) {
      const previousState = this.getProviderState(previousSnapshots, provider);
      const currentState = this.getProviderState(currentSnapshots, provider);

      if (previousState.found && !currentState.found) {
        diffs.push({
          domainId,
          analysisRunId,
          previousAnalysisRunId,
          diffType: "provider_mention_disappeared",
          provider,
          oldValue: previousState,
          newValue: currentState,
          severity: "critical"
        });
        continue;
      }

      if (!previousState.found && currentState.found) {
        diffs.push({
          domainId,
          analysisRunId,
          previousAnalysisRunId,
          diffType: "provider_recovered",
          provider,
          oldValue: previousState,
          newValue: currentState,
          severity: "info"
        });
        continue;
      }

      if (
        previousState.bestRank !== null &&
        currentState.bestRank !== null &&
        previousState.bestRank !== currentState.bestRank
      ) {
        diffs.push({
          domainId,
          analysisRunId,
          previousAnalysisRunId,
          diffType: "brand_rank_changed",
          provider,
          oldValue: { best_rank: previousState.bestRank },
          newValue: {
            best_rank: currentState.bestRank,
            change: currentState.bestRank - previousState.bestRank
          },
          severity: this.getRankChangeSeverity(previousState.bestRank, currentState.bestRank)
        });
      }
    }

    return diffs;
  }

  private getProviderState(snapshots: ProviderSnapshotRow[], provider: ProviderName): ProviderState {
    const rows = snapshots.filter(
      (snapshot) =>
        snapshot.llm_name === provider &&
        snapshot.status === "completed" &&
        DIFF_TOP_K_VALUES.has(snapshot.top_k)
    );
    const ranks = rows
      .map((row) => row.rank_position)
      .filter((rank): rank is number => rank !== null);
    const totalMentions = rows.reduce((sum, row) => sum + row.mention_count, 0);
    const found = rows.some(
      (row) => Number(row.score) > 0 || row.rank_position !== null || row.mention_count > 0
    );

    return {
      found,
      bestRank: ranks.length > 0 ? Math.min(...ranks) : null,
      totalMentions
    };
  }

  private getScoreDropSeverity(drop: number): AnalysisDiffSeverity {
    if (drop >= 15) {
      return "critical";
    }

    if (drop >= 5) {
      return "warning";
    }

    return "info";
  }

  private getRankChangeSeverity(previousRank: number, currentRank: number): AnalysisDiffSeverity {
    const change = Math.abs(currentRank - previousRank);
    return change >= 5 ? "warning" : "info";
  }
}
