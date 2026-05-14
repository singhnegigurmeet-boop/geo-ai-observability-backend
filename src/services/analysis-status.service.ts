import { AnalysisRunsRepository } from "../repositories/analysis-runs.repository.js";
import { DomainsRepository } from "../repositories/domains.repository.js";
import { ProviderAnalysisRepository } from "../repositories/provider-analysis.repository.js";
import { VisibilityScoresRepository } from "../repositories/visibility-scores.repository.js";

type AnalysisStatusServiceDependencies = {
  analysisRunsRepository: AnalysisRunsRepository;
  domainsRepository: DomainsRepository;
  providerAnalysisRepository: ProviderAnalysisRepository;
  visibilityScoresRepository: VisibilityScoresRepository;
};

export class AnalysisStatusService {
  constructor(private readonly dependencies: AnalysisStatusServiceDependencies) {}

  async getAnalysisJobStatus(jobId: number) {
    const analysisRun = await this.dependencies.analysisRunsRepository.findById(jobId);

    if (!analysisRun) {
      return {
        statusCode: 404,
        body: {
          status: "not_found",
          job_id: jobId,
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
            job_id: jobId,
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
          job_id: jobId,
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
          job_id: jobId,
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
        job_id: jobId,
        domain,
        run_status: analysisRun.status,
        started_at: analysisRun.started_at
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
