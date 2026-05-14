import { DomainsRepository } from "../repositories/domains.repository.js";
import { VisibilityScoresRepository } from "../repositories/visibility-scores.repository.js";
import { BaseService } from "./base.service.js";

type VisibilityScoreReadServiceDependencies = {
  domainsRepository: DomainsRepository;
  visibilityScoresRepository: VisibilityScoresRepository;
};

export class VisibilityScoreReadService extends BaseService {
  constructor(private readonly dependencies: VisibilityScoreReadServiceDependencies) {
    super();
  }

  async getLatestVisibilityScore(domainId: number) {
    const domainRow = await this.dependencies.domainsRepository.findDomainById(domainId);

    if (!domainRow) {
      return this.notFoundDomain(domainId);
    }

    const visibilityScore = await this.dependencies.visibilityScoresRepository.findLatestVisibilityScore(domainRow.id);

    if (!visibilityScore) {
      return {
        statusCode: 404,
        body: {
          status: "not_found",
          domain_id: domainRow.id,
          domain: domainRow.domain,
          error: "No visibility score found for this domain"
        }
      };
    }

    return {
      statusCode: 200,
      body: {
        status: "found",
        source: "visibility_scores",
        domain_id: domainRow.id,
        domain: domainRow.domain,
        data: visibilityScore
      }
    };
  }

  async getVisibilityScoreHistory(domainId: number) {
    const domainRow = await this.dependencies.domainsRepository.findDomainById(domainId);

    if (!domainRow) {
      return this.notFoundDomain(domainId);
    }

    const history = await this.dependencies.visibilityScoresRepository.findVisibilityScoreHistory(domainRow.id);

    return {
      statusCode: 200,
      body: {
        status: "found",
        source: "visibility_scores",
        domain_id: domainRow.id,
        domain: domainRow.domain,
        history
      }
    };
  }

  async getVisibilityScoreTrend(domainId: number) {
    const domainRow = await this.dependencies.domainsRepository.findDomainById(domainId);

    if (!domainRow) {
      return this.notFoundDomain(domainId);
    }

    const history = await this.dependencies.visibilityScoresRepository.findVisibilityScoreHistory(domainRow.id, 2);
    const current = history[0] ?? null;
    const previous = history[1] ?? null;

    if (!current) {
      return {
        statusCode: 404,
        body: {
          status: "not_found",
          domain_id: domainRow.id,
          domain: domainRow.domain,
          error: "No visibility score found for this domain"
        }
      };
    }

    const currentScore = Number(current.overall_geo_score);
    const previousScore = previous ? Number(previous.overall_geo_score) : null;
    const change = previousScore === null ? null : this.roundNumber(currentScore - previousScore, 2);

    return {
      statusCode: 200,
      body: {
        domain: domainRow.domain,
        domain_id: domainRow.id,
        current_score: currentScore,
        previous_score: previousScore,
        change,
        trend: this.getTrend(change),
        current_created_at: current.created_at,
        previous_created_at: previous?.created_at ?? null
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

  private getTrend(change: number | null) {
    if (change === null) {
      return "insufficient_history";
    }

    if (change > 0) {
      return "improved";
    }

    if (change < 0) {
      return "dropped";
    }

    return "stable";
  }
}
