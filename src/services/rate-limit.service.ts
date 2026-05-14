import type { Redis } from "ioredis";
import type { RateLimitResult } from "../types/rate-limit.types.js";

type RateLimitServiceDependencies = {
  redis: Redis;
  uniqueDomainsPerIpLimit: number;
  uniqueDomainsTtlSeconds: number;
  sameDomainPerIpLimit: number;
  sameDomainTtlSeconds: number;
};

export class RateLimitService {
  constructor(private readonly dependencies: RateLimitServiceDependencies) {}

  async checkSameDomainLimit(ipAddress: string, domain: string): Promise<RateLimitResult> {
    const key = `rate_limit:same_domain:${ipAddress}:${domain}`;
    const current = await this.incrementWithTtl(key, this.dependencies.sameDomainTtlSeconds);

    if (current > this.dependencies.sameDomainPerIpLimit) {
      return {
        allowed: false,
        current,
        limit: this.dependencies.sameDomainPerIpLimit,
        retryAfterSeconds: await this.getRetryAfterSeconds(key, this.dependencies.sameDomainTtlSeconds),
        reason: "Same domain request limit exceeded"
      };
    }

    return {
      allowed: true,
      current,
      limit: this.dependencies.sameDomainPerIpLimit
    };
  }

  async checkUniqueDomainLimit(ipAddress: string, domain: string): Promise<RateLimitResult> {
    const key = `rate_limit:unique_domains:${ipAddress}:${this.getUtcDateKey()}`;
    const current = await this.addToSetWithTtl(key, domain, this.dependencies.uniqueDomainsTtlSeconds);
    if (current > this.dependencies.uniqueDomainsPerIpLimit) {
      return {
        allowed: false,
        current,
        limit: this.dependencies.uniqueDomainsPerIpLimit,
        retryAfterSeconds: await this.getRetryAfterSeconds(key, this.dependencies.uniqueDomainsTtlSeconds),
        reason: "Unique domain analysis limit exceeded"
      };
    }

    return {
      allowed: true,
      current,
      limit: this.dependencies.uniqueDomainsPerIpLimit
    };
  }

  private async getRetryAfterSeconds(key: string, fallbackSeconds: number) {
    const ttl = await this.dependencies.redis.ttl(key);
    return ttl > 0 ? ttl : fallbackSeconds;
  }

  private async incrementWithTtl(key: string, ttlSeconds: number) {
    const current = await this.dependencies.redis.incr(key);

    if (current === 1) {
      await this.dependencies.redis.expire(key, ttlSeconds);
    }

    return current;
  }

  private async addToSetWithTtl(key: string, value: string, ttlSeconds: number) {
    await this.dependencies.redis.sadd(key, value);
    await this.dependencies.redis.expire(key, ttlSeconds);
    return this.dependencies.redis.scard(key);
  }

  private getUtcDateKey() {
    return new Date().toISOString().slice(0, 10);
  }
}
