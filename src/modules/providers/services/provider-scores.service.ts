import { DomainsRepository } from "../../../repositories/domains.repository.js";
import { ProviderAnalysisRepository } from "../repositories/provider-analysis.repository.js";
import { ProviderSnapshotsRepository } from "../repositories/provider-snapshots.repository.js";
import { BaseService } from "../../../services/base.service.js";
import type { ProviderName } from "../../../config/constants.js";

type ProviderScoresServiceDependencies = {
  domainsRepository: DomainsRepository;
  providerAnalysisRepository: ProviderAnalysisRepository;
  providerSnapshotsRepository: ProviderSnapshotsRepository;
};

export class ProviderScoresService extends BaseService {
  constructor(private readonly dependencies: ProviderScoresServiceDependencies) {
    super();
  }

  async getLatestProviderScores(domainId: number, llmName: ProviderName) {
    const domainRow = await this.dependencies.domainsRepository.findDomainById(domainId);

    if (!domainRow) {
      return this.notFoundDomain(domainId);
    }

    const scores = await this.dependencies.providerAnalysisRepository.findLatestScoresByDomainAndProvider(
      domainRow.id,
      llmName
    );

    if (scores.length === 0) {
      return {
        statusCode: 404,
        body: {
          status: "not_found",
          domain_id: domainId,
          domain: domainRow.domain,
          llm_name: llmName,
          error: "No latest provider score found for this domain and model"
        }
      };
    }

    return {
      statusCode: 200,
      body: {
        status: "found",
        source: "provider_analysis",
        domain_id: domainRow.id,
        domain: domainRow.domain,
        provider: llmName,
        scores: scores.map((score) => ({
          top_k: score.top_k,
          rank_position: score.rank_position,
          mention_count: score.mention_count,
          score: score.score,
          status: score.status,
          error_message: score.error_message,
          last_run: score.last_run,
          updated_at: score.updated_at
        }))
      }
    };
  }

  async getLatestProviderScoreComparison(domainId: number) {
    const domainRow = await this.dependencies.domainsRepository.findDomainById(domainId);

    if (!domainRow) {
      return this.notFoundDomain(domainId);
    }

    const scores = await this.dependencies.providerAnalysisRepository.findLatestScoresByDomain(domainRow.id);

    if (scores.length === 0) {
      return {
        statusCode: 404,
        body: {
          status: "not_found",
          domain_id: domainRow.id,
          domain: domainRow.domain,
          error: "No latest provider scores found for this domain"
        }
      };
    }

    const providers = scores.reduce<Record<string, unknown[]>>((accumulator, score) => {
      accumulator[score.llm_name] ??= [];
      accumulator[score.llm_name].push({
        top_k: score.top_k,
        rank_position: score.rank_position,
        mention_count: score.mention_count,
        score: score.score,
        status: score.status,
        error_message: score.error_message,
        last_run: score.last_run,
        updated_at: score.updated_at
      });
      return accumulator;
    }, {});

    return {
      statusCode: 200,
      body: {
        status: "found",
        source: "provider_analysis",
        domain_id: domainRow.id,
        domain: domainRow.domain,
        providers
      }
    };
  }

  async getProviderScoreHistory(domainId: number, llmName: ProviderName) {
    const domainRow = await this.dependencies.domainsRepository.findDomainById(domainId);

    if (!domainRow) {
      return this.notFoundDomain(domainId);
    }

    const history = await this.dependencies.providerSnapshotsRepository.findProviderSnapshotHistory(
      domainRow.id,
      llmName
    );

    return {
      statusCode: 200,
      body: {
        status: "found",
        source: "provider_snapshots",
        domain_id: domainRow.id,
        domain: domainRow.domain,
        provider: llmName,
        history
      }
    };
  }

  private notFoundDomain(domainId: number) {
    return {
      statusCode: 404,
      body: {
        status: "not_found",
        domain_id: domainId,
        error: "Domain has not been analyzed yet"
      }
    };
  }
}
