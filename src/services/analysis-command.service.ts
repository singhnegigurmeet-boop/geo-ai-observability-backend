import { AnalysisRunsRepository } from "../repositories/analysis-runs.repository.js";
import { DomainsRepository } from "../repositories/domains.repository.js";
import { VisibilityScoresRepository } from "../repositories/visibility-scores.repository.js";
import { BaseService } from "./base.service.js";
import { RateLimitService } from "./rate-limit.service.js";
import type { AnalysisJobData } from "../types/queue.types.js";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";

type AnalysisCommandServiceDependencies = {
  analysisRunsRepository: AnalysisRunsRepository;
  domainsRepository: DomainsRepository;
  visibilityScoresRepository: VisibilityScoresRepository;
  queue: Queue<AnalysisJobData>;
  redis: Redis;
  rateLimitService: RateLimitService;
  cacheTtlSeconds: number;
  staleHours: number;
};

export class AnalysisCommandService extends BaseService {
  constructor(private readonly dependencies: AnalysisCommandServiceDependencies) {
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
}
