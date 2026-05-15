import { AnalysisRunsRepository } from "../repositories/analysis-runs.repository.js";
import { DomainsRepository } from "../../../repositories/domains.repository.js";
import { AnalysisDiffsRepository } from "../../diffs/repositories/analysis-diffs.repository.js";
import { ProviderAnalysisRepository } from "../../providers/repositories/provider-analysis.repository.js";
import { VisibilityScoresRepository } from "../../visibility/repositories/visibility-scores.repository.js";

type AnalysisStatusServiceDependencies = {
  analysisRunsRepository: AnalysisRunsRepository;
  domainsRepository: DomainsRepository;
  analysisDiffsRepository: AnalysisDiffsRepository;
  providerAnalysisRepository: ProviderAnalysisRepository;
  visibilityScoresRepository: VisibilityScoresRepository;
};

export class AnalysisStatusService {
  constructor(private readonly dependencies: AnalysisStatusServiceDependencies) {}

  async getAnalysisJobStatus(analysisRunId: number) {
    const analysisRun = await this.dependencies.analysisRunsRepository.findById(analysisRunId);

    if (!analysisRun) {
      return {
        statusCode: 404,
        body: {
          status: "not_found",
          analysis_run_id: analysisRunId,
          error: "Analysis job not found"
        }
      };
    }

    const domainRow = await this.dependencies.domainsRepository.findDomainById(analysisRun.domain_id);
    const domain = domainRow?.domain;

    if (analysisRun.status === "completed" || analysisRun.status === "partial_success") {
      const latestScore = await this.dependencies.visibilityScoresRepository.findLatestVisibilityScore(
        analysisRun.domain_id
      );
      const providers = await this.getProviderStatusMap(analysisRun.domain_id);

      if (!latestScore) {
        return {
          statusCode: 202,
          body: {
            status: "processing",
            analysis_run_id: analysisRunId,
            domain,
            run_status: analysisRun.status,
            providers,
            message: "Analysis run finished but result is not available yet"
          }
        };
      }

      return {
        statusCode: 200,
        body: {
          status: analysisRun.status,
          analysis_run_id: analysisRunId,
          domain,
          providers,
          completed_at: analysisRun.completed_at,
          data: latestScore
        }
      };
    }

    if (analysisRun.status === "failed") {
      const providers = await this.getProviderStatusMap(analysisRun.domain_id);

      return {
        statusCode: 200,
        body: {
          status: "failed",
          analysis_run_id: analysisRunId,
          domain,
          providers,
          completed_at: analysisRun.completed_at,
          error: analysisRun.error_message ?? "Analysis failed"
        }
      };
    }

    return {
      statusCode: 202,
      body: {
        status: "processing",
        analysis_run_id: analysisRunId,
        domain,
        run_status: analysisRun.status,
        started_at: analysisRun.started_at
      }
    };
  }

  async getAnalysisJobDiffs(analysisRunId: number) {
    const analysisRun = await this.dependencies.analysisRunsRepository.findById(analysisRunId);

    if (!analysisRun) {
      return {
        statusCode: 404,
        body: {
          status: "not_found",
          analysis_run_id: analysisRunId,
          error: "Analysis job not found"
        }
      };
    }

    const domainRow = await this.dependencies.domainsRepository.findDomainById(analysisRun.domain_id);
    const diffs = await this.dependencies.analysisDiffsRepository.findDiffsByRunId(analysisRunId);

    return {
      statusCode: 200,
      body: {
        status: "found",
        source: "analysis_diffs",
        analysis_run_id: analysisRunId,
        domain_id: analysisRun.domain_id,
        domain: domainRow?.domain ?? null,
        diffs
      }
    };
  }

  private async getProviderStatusMap(domainId: number) {
    const providerStatuses = await this.dependencies.providerAnalysisRepository.findProviderStatusesForDomain(domainId);

    return Object.fromEntries(
      providerStatuses.map((providerStatus) => [
        providerStatus.llm_name,
        {
          status: providerStatus.status,
          error_message: providerStatus.error_message
        }
      ])
    );
  }
}
