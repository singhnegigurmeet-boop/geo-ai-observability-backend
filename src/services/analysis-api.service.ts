import { AnalysisRunsRepository } from "../repositories/analysis-runs.repository.js";
import { DomainsRepository } from "../repositories/domains.repository.js";
import { ProviderAnalysisRepository } from "../repositories/provider-analysis.repository.js";
import { VisibilityScoresRepository } from "../repositories/visibility-scores.repository.js";
import { BaseService } from "./base.service.js";
import { RateLimitService } from "./rate-limit.service.js";
import type { ProviderName } from "../config/constants.js";
import type { AnalysisJobData } from "../types/queue.types.js";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";

type AnalysisApiServiceDependencies = {
  analysisRunsRepository: AnalysisRunsRepository;
  domainsRepository: DomainsRepository;
  providerAnalysisRepository: ProviderAnalysisRepository;
  visibilityScoresRepository: VisibilityScoresRepository;
  queue: Queue<AnalysisJobData>;
  redis: Redis;
  rateLimitService: RateLimitService;
  cacheTtlSeconds: number;
  staleHours: number;
};

export class AnalysisApiService extends BaseService {
  constructor(private readonly dependencies: AnalysisApiServiceDependencies) {
    super();
  }

  async enqueueOrReturnCachedAnalysis(rawDomain: string, ipAddress: string) {
    const domain = this.normalizeDomain(rawDomain);
    const cacheKey = `analysis:${domain}`;
    const sameDomainLimit = await this.dependencies.rateLimitService.checkSameDomainLimit(ipAddress, domain);

    if (!sameDomainLimit.allowed) {
      this.log("Rate limit exceeded", { ipAddress, domain, reason: sameDomainLimit.reason });
      this.log("Blocked request", { ipAddress, domain });
      return {
        statusCode: 429,
        body: {
          status: "rate_limited",
          error: sameDomainLimit.reason,
          limit: sameDomainLimit.limit,
          current: sameDomainLimit.current,
          retry_after_seconds: sameDomainLimit.retryAfterSeconds
        }
      };
    }

    const cached = await this.dependencies.redis.get(cacheKey);

    if (cached) {
      this.log("Cache hit", { domain, ipAddress });
      return {
        statusCode: 200,
        body: { source: "cache", data: JSON.parse(cached) }
      };
    }

    this.log("Cache miss", { domain, ipAddress });
    const domainRow = await this.dependencies.domainsRepository.upsertDomain(domain);
    const latestScore = await this.dependencies.visibilityScoresRepository.findLatestVisibilityScore(domainRow.id);

    if (latestScore && this.isFresh(latestScore.created_at)) {
      await this.dependencies.redis.set(
        cacheKey,
        JSON.stringify(latestScore),
        "EX",
        this.dependencies.cacheTtlSeconds
      );

      this.log("Fresh PostgreSQL score found; caching result", { domain, ipAddress });
      return {
        statusCode: 200,
        body: { source: "postgres", data: latestScore }
      };
    }

    const uniqueDomainLimit = await this.dependencies.rateLimitService.checkUniqueDomainLimit(ipAddress, domain);
    if (!uniqueDomainLimit.allowed) {
      this.log("Rate limit exceeded", { ipAddress, domain, reason: uniqueDomainLimit.reason });
      this.log("Blocked request", { ipAddress, domain });
      return {
        statusCode: 429,
        body: {
          status: "rate_limited",
          error: uniqueDomainLimit.reason,
          limit: uniqueDomainLimit.limit,
          current: uniqueDomainLimit.current,
          retry_after_seconds: uniqueDomainLimit.retryAfterSeconds
        }
      };
    }

    const analysisRun = await this.dependencies.analysisRunsRepository.createQueuedRun(domainRow.id);
    const job = await this.dependencies.queue.add("analyze-domain", {
      analysisRunId: analysisRun.id,
      domainId: domainRow.id,
      domain
    });

    await this.dependencies.analysisRunsRepository.attachBullMqJob(analysisRun.id, String(job.id));
    this.log("Analysis queued", { domain, ipAddress, analysisRunId: analysisRun.id, bullMqJobId: job.id });

    return {
      statusCode: 202,
      body: {
        status: "queued",
        job_id: analysisRun.id,
        domain_id: domainRow.id,
        bullmq_job_id: job.id,
        message: "Analysis started",
        domain
      }
    };
  }

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

  async getLatestProviderScores(domainId: number, llmName: ProviderName) {
    const domainRow = await this.dependencies.domainsRepository.findDomainById(domainId);

    if (!domainRow) {
      return {
        statusCode: 404,
        body: {
          status: "not_found",
          domain_id: domainId,
          llm_name: llmName,
          error: "Domain has not been analyzed yet"
        }
      };
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
      return {
        statusCode: 404,
        body: {
          status: "not_found",
          domain_id: domainId,
          error: "Domain has not been analyzed yet"
        }
      };
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

  async getLatestVisibilityScore(domainId: number) {
    const domainRow = await this.dependencies.domainsRepository.findDomainById(domainId);

    if (!domainRow) {
      return {
        statusCode: 404,
        body: {
          status: "not_found",
          domain_id: domainId,
          error: "Domain has not been analyzed yet"
        }
      };
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

  private isFresh(createdAt: Date) {
    const staleAfterMs = this.dependencies.staleHours * 60 * 60 * 1000;
    return Date.now() - createdAt.getTime() <= staleAfterMs;
  }

  private normalizeDomain(input: string) {
    const trimmed = input.trim().toLowerCase();
    const withoutProtocol = trimmed.replace(/^https?:\/\//, "");
    const withoutPath = withoutProtocol.split("/")[0] ?? "";
    const withoutPort = withoutPath.split(":")[0] ?? "";
    return withoutPort.replace(/^www\./, "");
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
