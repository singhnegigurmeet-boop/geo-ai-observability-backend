import type { DatabaseExecutor } from "../../../common/database/database-executor.js";
import type { HierarchyDiscoveryJobRow, JsonObject } from "../../../common/types/database.types.js";
import { OutboxEventWriterRepository } from "../../outbox/repositories/outbox-event-writer.repository.js";
import { HierarchyDiscoveryRepository } from "../repositories/hierarchy-discovery.repository.js";

export class HierarchyDiscoveryResultService {
  constructor(private readonly database: DatabaseExecutor) {}

  async apply(job: HierarchyDiscoveryJobRow, providerResultId: string, response: JsonObject | null) {
    const repository = new HierarchyDiscoveryRepository(this.database);
    if (!response) {
      await repository.terminal(job.hierarchy_discovery_job_id, "invalid", "DISCOVERY_OUTPUT_INVALID", "Provider output did not satisfy the discovery contract.");
      await this.resume(job);
      return;
    }
    const rows = (response.selections ?? response.items) as JsonObject[];
    for (const row of rows) {
      if (job.stage === "category") await this.applyCategory(repository, job, providerResultId, row);
      else if (job.stage === "brand") await this.applyBrand(repository, job, providerResultId, row);
      else if (job.stage === "product") await this.applyProduct(repository, job, providerResultId, row);
      else await this.applyUseContext(repository, job, providerResultId, row);
    }
    await repository.terminal(job.hierarchy_discovery_job_id, rows.length ? "completed" : "completed_empty");
    await this.resume(job);
  }

  private async applyCategory(repository: HierarchyDiscoveryRepository, job: HierarchyDiscoveryJobRow, resultId: string, row: JsonObject) {
    const categoryId = row.category_id as string;
    const existing = await this.database.query<{domain_category_id:string;is_active:boolean}>("SELECT domain_category_id,is_active FROM domain_categories WHERE domain_id=$1 AND category_id=$2 FOR UPDATE",[job.domain_id,categoryId]);
    const action = !existing.rows[0] ? "created" : existing.rows[0].is_active ? "reused" : "reactivated";
    const result = await this.database.query<{domain_category_id:string}>(`INSERT INTO domain_categories(domain_id,category_id,is_active,sort_order,source,discovery_provider_result_id,discovery_rank,discovery_confidence,discovery_reason,discovered_at) VALUES($1,$2,true,$3,'llm_discovery',$4,$3,$5,$6,now()) ON CONFLICT(domain_id,category_id) DO UPDATE SET is_active=true,source='llm_discovery',discovery_provider_result_id=EXCLUDED.discovery_provider_result_id,discovery_rank=EXCLUDED.discovery_rank,discovery_confidence=EXCLUDED.discovery_confidence,discovery_reason=EXCLUDED.discovery_reason,discovered_at=now(),updated_at=now() RETURNING domain_category_id`,[job.domain_id,categoryId,row.rank,resultId,row.confidence,row.reason]);
    await repository.recordRelationship({jobId:job.hierarchy_discovery_job_id,edge:"domain_category",edgeId:result.rows[0]!.domain_category_id,providerResultId:resultId,action,rank:row.rank as number,confidence:row.confidence as number,reason:row.reason as string});
  }

  private async applyBrand(repository: HierarchyDiscoveryRepository, job: HierarchyDiscoveryJobRow, resultId: string, row: JsonObject) {
    const name=cleanName(row.name as string); const normalized=normalizeName(name);
    const brand=await this.database.query<{brand_id:string}>(`INSERT INTO brands(brand_name,normalized_name,is_active) VALUES($1,$2,true) ON CONFLICT(normalized_name) DO UPDATE SET is_active=true,updated_at=now() RETURNING brand_id`,[name,normalized]);
    const existing=await this.database.query<{category_brand_id:string;is_active:boolean}>("SELECT category_brand_id,is_active FROM category_brands WHERE domain_category_id=$1 AND brand_id=$2 FOR UPDATE",[job.domain_category_id,brand.rows[0]!.brand_id]);
    const action=!existing.rows[0]?"created":existing.rows[0].is_active?"reused":"reactivated";
    const edge=await this.database.query<{category_brand_id:string}>(`INSERT INTO category_brands(domain_category_id,brand_id,is_active,sort_order,source) VALUES($1,$2,true,$3,'llm_discovery') ON CONFLICT(domain_category_id,brand_id) DO UPDATE SET is_active=true,sort_order=EXCLUDED.sort_order,source='llm_discovery',updated_at=now() RETURNING category_brand_id`,[job.domain_category_id,brand.rows[0]!.brand_id,row.rank]);
    await repository.recordRelationship({jobId:job.hierarchy_discovery_job_id,edge:"category_brand",edgeId:edge.rows[0]!.category_brand_id,providerResultId:resultId,action,rank:row.rank as number,confidence:row.confidence as number,reason:row.reason as string});
  }

  private async applyProduct(repository: HierarchyDiscoveryRepository, job: HierarchyDiscoveryJobRow, resultId: string, row: JsonObject) {
    const name=cleanName(row.name as string); const normalized=normalizeName(name);
    const product=await this.database.query<{product_id:string}>(`INSERT INTO products(product_name,normalized_name,is_active) VALUES($1,$2,true) ON CONFLICT(normalized_name) DO UPDATE SET is_active=true,updated_at=now() RETURNING product_id`,[name,normalized]);
    const existing=await this.database.query<{brand_product_id:string;is_active:boolean}>("SELECT brand_product_id,is_active FROM brand_products WHERE category_brand_id=$1 AND product_id=$2 FOR UPDATE",[job.category_brand_id,product.rows[0]!.product_id]);
    const action=!existing.rows[0]?"created":existing.rows[0].is_active?"reused":"reactivated";
    const edge=await this.database.query<{brand_product_id:string}>(`INSERT INTO brand_products(category_brand_id,product_id,is_active,sort_order,source) VALUES($1,$2,true,$3,'llm_discovery') ON CONFLICT(category_brand_id,product_id) DO UPDATE SET is_active=true,sort_order=EXCLUDED.sort_order,source='llm_discovery',updated_at=now() RETURNING brand_product_id`,[job.category_brand_id,product.rows[0]!.product_id,row.rank]);
    await repository.recordRelationship({jobId:job.hierarchy_discovery_job_id,edge:"brand_product",edgeId:edge.rows[0]!.brand_product_id,providerResultId:resultId,action,rank:row.rank as number,confidence:row.confidence as number,reason:row.reason as string});
  }

  private async applyUseContext(repository: HierarchyDiscoveryRepository, job: HierarchyDiscoveryJobRow, resultId: string, row: JsonObject) {
    const contextId=row.use_context_id as string;
    const active=await this.database.query("SELECT 1 FROM use_contexts WHERE use_context_id=$1 AND is_active FOR KEY SHARE",[contextId]);
    if(!active.rows[0]) throw new Error("Frozen discovery use-context candidate is inactive");
    const existing=await this.database.query<{product_use_context_id:string;is_active:boolean}>("SELECT product_use_context_id,is_active FROM product_use_contexts WHERE brand_product_id=$1 AND use_context_id=$2 FOR UPDATE",[job.brand_product_id,contextId]);
    const action=!existing.rows[0]?"created":existing.rows[0].is_active?"reused":"reactivated";
    const edge=await this.database.query<{product_use_context_id:string}>(`INSERT INTO product_use_contexts(brand_product_id,use_context_id,is_active,sort_order,source) VALUES($1,$2,true,$3,'llm_discovery') ON CONFLICT(brand_product_id,use_context_id) DO UPDATE SET is_active=true,sort_order=EXCLUDED.sort_order,source='llm_discovery',updated_at=now() RETURNING product_use_context_id`,[job.brand_product_id,contextId,row.rank]);
    await repository.recordRelationship({jobId:job.hierarchy_discovery_job_id,edge:"product_use_context",edgeId:edge.rows[0]!.product_use_context_id,providerResultId:resultId,action,rank:row.rank as number,confidence:row.confidence as number,reason:row.reason as string});
  }

  private async resume(job: HierarchyDiscoveryJobRow) {
    await new OutboxEventWriterRepository(this.database).createOrReuse({eventKey:`pre_analysis_request.discovery_progress:${job.pre_analysis_request_id}:${job.hierarchy_discovery_job_id}`,eventType:"pre_analysis_request.discovery_progress",eventVersion:1,aggregateType:"pre_analysis_request",aggregateId:job.pre_analysis_request_id,headers:{queueName:"domain_hierarchy_discovery_queue"},payload:{preAnalysisRequestId:job.pre_analysis_request_id}});
  }
}

function cleanName(value:string){const cleaned=value.trim().replace(/\s+/g," ");if(!cleaned||cleaned.length>500)throw new Error("Discovered name is invalid");return cleaned;}
function normalizeName(value:string){return value.toLocaleLowerCase("en-US");}
