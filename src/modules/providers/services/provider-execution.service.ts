import type { DatabaseExecutor, TransactionPool } from "../../../common/database/database-executor.js";
import { inTransaction } from "../../../common/database/database-executor.js";
import type { JsonObject, ProviderName } from "../../../common/types/database.types.js";
import { BudgetCheckService } from "../../budgets/services/budget-check.service.js";
import { BudgetRepository } from "../../budgets/repositories/budget.repository.js";
import { estimateCostMicros } from "../../budgets/policies/provider-pricing.policy.js";
import { HierarchyDiscoveryRepository } from "../../discovery/repositories/hierarchy-discovery.repository.js";
import { PreAnalysisRequestRepository } from "../../discovery/repositories/pre-analysis-request.repository.js";
import { HierarchyDiscoveryResultService } from "../../discovery/services/hierarchy-discovery-result.service.js";
import { ExecutionStateService } from "../../execution/services/execution-state.service.js";
import { OutboxEventWriterRepository } from "../../outbox/repositories/outbox-event-writer.repository.js";
import { requiresScoring } from "../../prompts/policies/prompt-policy.registry.js";
import { ReportRepository } from "../../reports/repositories/report.repository.js";
import { ReportAggregationService } from "../../reports/services/report-aggregation.service.js";
import { ProviderAdapterRegistry } from "../adapters/provider-adapter.registry.js";
import { ProviderExecutionError } from "../errors/provider-execution.error.js";
import type { ProviderJobCreatedPayload } from "../messages/provider-worker.messages.js";
import { AuthoritativeEntityPathContextRepository } from "../repositories/authoritative-entity-path-context.repository.js";
import { ProviderExecutionRepository, type ProviderExecutionState } from "../repositories/provider-execution.repository.js";
import { ProviderJobRepository } from "../repositories/provider-job.repository.js";
import { providerModelProfile } from "../registry/provider-model.registry.js";
import type { ProviderAdapter, ProviderGeneratedOutput } from "../types/provider-adapter.types.js";
import { retainGeneratedContent, validateDiscoveryOutput, validateProviderOutput } from "./provider-output-validation.service.js";

type ProviderDatabase = DatabaseExecutor & TransactionPool;
export type ProviderExecutionOutcome = { outcome:"completed";providerResultId:string } | { outcome:"paused_budget";providerResultId:null;budgetPolicyId:string|null } | { outcome:"fallback_enqueued";providerResultId:null } | { outcome:"noop";providerResultId:null };

export class ProviderExecutionService {
  constructor(private readonly database: ProviderDatabase, private readonly adapters: ProviderAdapterRegistry, private readonly timeoutMs: number) {}

  async execute(payload: ProviderJobCreatedPayload, expectedProvider?: ProviderName): Promise<ProviderExecutionOutcome> {
    return inTransaction(this.database, async (client) => {
      const repository = new ProviderExecutionRepository(client);
      await repository.lockAnalysisRunForProviderJob(payload.providerJobId);
      const state = await repository.findForUpdate(payload.providerJobId);
      if (!state) throw new ProviderExecutionError("PROVIDER_JOB_NOT_FOUND",`Provider job ${payload.providerJobId} does not exist`);
      if (state.status !== "queued") return {outcome:"noop",providerResultId:null};
      if (expectedProvider && expectedProvider !== state.provider) throw new ProviderExecutionError("PROVIDER_QUEUE_MISMATCH",`Provider job does not belong on the ${expectedProvider} queue`,true);
      const adapter=this.adapters.resolve(state.provider,state.model);
      return state.job_kind === "hierarchy_discovery"
        ? this.executeDiscovery(client,repository,state,adapter)
        : this.executeNormal(client,repository,state,adapter);
    });
  }

  private async executeNormal(client:DatabaseExecutor,repository:ProviderExecutionRepository,state:ProviderExecutionState,adapter:ProviderAdapter):Promise<ProviderExecutionOutcome>{
    if(state.prompt_job_id===null||state.prompt_type===null||state.prompt_depth===null||state.business_prompt_version===null||state.prompt_input_payload===null||state.prompt_status!=="processing"||!state.prompt_text?.trim()||state.analysis_run_id===null) throw new ProviderExecutionError("PROMPT_NOT_RENDERED","Provider execution requires a rendered active prompt",true);
    if(state.analysis_run_status==="paused_budget"){await pauseNormal(repository,state);await new ExecutionStateService(client).recalculateRun(state.analysis_run_id);await snapshot(client,state.analysis_run_id);return{outcome:"paused_budget",providerResultId:null,budgetPolicyId:null};}
    const profile=providerModelProfile(state.provider,state.model);if(!profile||profile.modelProfileVersion!==state.model_profile_version)throw new ProviderExecutionError("MODEL_PROFILE_VERSION_MISMATCH","Frozen provider model profile is unavailable",true);
    const budget=await new BudgetCheckService(new BudgetRepository(client)).checkAndReserve({providerJobId:state.provider_job_id,provider:state.provider,model:state.model,workspaceId:state.workspace_id,userId:state.user_id,anonymousSessionId:state.anonymous_session_id,analysisRunId:state.analysis_run_id,promptText:state.prompt_text,promptType:state.prompt_type,promptDepth:state.prompt_depth});
    if(!budget.allowed){await pauseNormal(repository,state);await new ExecutionStateService(client).recalculateRun(state.analysis_run_id);await snapshot(client,state.analysis_run_id);return{outcome:"paused_budget",providerResultId:null,budgetPolicyId:budget.decision.budgetPolicyId};}
    if(!await repository.markProcessing(state.provider_job_id))throw new ProviderExecutionError("PROVIDER_JOB_TRANSITION_FAILED","Provider job could not transition to processing");
    let execution:ProviderGeneratedOutput;
    let transportValidationErrors: JsonObject[] | null = null;
    try{execution=await adapter.execute({providerJobId:state.provider_job_id,provider:state.provider,model:state.model,promptText:state.prompt_text,promptType:state.prompt_type,promptDepth:state.prompt_depth,responseContractVersion:state.response_contract_version,structuredOutputMode:state.structured_output_mode,maximumOutputTokens:profile.maximumOutputTokens[state.prompt_depth],exactTargetName:targetName(state.request_payload),timeoutMs:this.timeoutMs});}
    catch(error){if(!(error instanceof ProviderExecutionError)||!error.invalidEvidence)throw error;execution=invalidExecution(error,state.model);transportValidationErrors=error.invalidEvidence.validationErrors.map((message)=>({layer:"provider_transport",code:"GENERATED_CONTENT_MISSING",message}));}
    const authoritative=await new AuthoritativeEntityPathContextRepository(client).loadForProviderJob(state.provider_job_id);
    const validation=transportValidationErrors ? {valid:false as const,validatedResponse:null,validationErrors:transportValidationErrors,contextValidationStatus:"invalid" as const} : validateProviderOutput({generatedContent:execution.generatedContent,promptType:state.prompt_type,promptDepth:state.prompt_depth,responseContractVersion:state.response_contract_version,frozenContext:state.prompt_input_payload.entityPathContext,authoritativeContext:authoritative,promptInputPayload:state.prompt_input_payload});
    const result=await saveEvidence(repository,state,execution,validation.valid?validation.validatedResponse:null,validation.validationErrors,validation.contextValidationStatus,budget.estimate);
    if(validation.valid&&requiresScoring(state.prompt_type))await new OutboxEventWriterRepository(client).createOrReuse({eventKey:`provider_result.created:${result.provider_result_id}`,eventType:"provider_result.created",eventVersion:1,aggregateType:"provider_result",aggregateId:result.provider_result_id,headers:{queueName:"scoring_queue"},payload:{providerResultId:result.provider_result_id}});
    if(!await repository.markSucceeded(state.provider_job_id))throw new ProviderExecutionError("PROVIDER_JOB_TRANSITION_FAILED","Provider job could not transition to succeeded");
    await new ExecutionStateService(client).recalculateRun(state.analysis_run_id);
    if(!validation.valid||!requiresScoring(state.prompt_type))await snapshot(client,state.analysis_run_id);
    return{outcome:"completed",providerResultId:result.provider_result_id};
  }

  private async executeDiscovery(client:DatabaseExecutor,repository:ProviderExecutionRepository,state:ProviderExecutionState,adapter:ProviderAdapter):Promise<ProviderExecutionOutcome>{
    if(state.discovery_job_id===null||state.pre_analysis_request_id===null||state.discovery_stage===null||state.discovery_status!=="processing"||state.discovery_input_payload===null||!state.prompt_text?.trim())throw new ProviderExecutionError("DISCOVERY_NOT_RENDERED","Discovery provider execution requires a rendered active job",true);
    const job=await new HierarchyDiscoveryRepository(client).findJobForUpdate(state.discovery_job_id);if(!job)throw new ProviderExecutionError("DISCOVERY_JOB_NOT_FOUND","Discovery job does not exist",true);
    const profile=providerModelProfile(state.provider,state.model);if(!profile||profile.modelProfileVersion!==state.model_profile_version||!profile.eligibleForDiscovery)throw new ProviderExecutionError("MODEL_PROFILE_VERSION_MISMATCH","Frozen discovery model profile is unavailable",true);
    const context=parseDiscoveryContext(state.discovery_input_payload,state.discovery_stage);
    const active=state.discovery_stage==="category"?await activeIds(client,"categories","category_id",context.candidates.map(v=>v.id)):state.discovery_stage==="use_context"?await activeIds(client,"use_contexts","use_context_id",context.candidates.map(v=>v.id)):new Set<string>();
    const budget=await new BudgetCheckService(new BudgetRepository(client)).checkAndReserve({providerJobId:state.provider_job_id,provider:state.provider,model:state.model,workspaceId:state.workspace_id,userId:state.user_id,anonymousSessionId:state.anonymous_session_id,analysisRunId:null,promptText:state.prompt_text,promptType:`hierarchy_discovery_${state.discovery_stage}`,promptDepth:"weak"});
    if(!budget.allowed){await client.query("UPDATE provider_jobs SET status='paused_budget',error_code='DISCOVERY_BUDGET_EXHAUSTED',error_message='Configured LLM budget prevented discovery.',updated_at=now() WHERE provider_job_id=$1",[state.provider_job_id]);await client.query("UPDATE hierarchy_discovery_jobs SET status='paused_budget',error_code='DISCOVERY_BUDGET_EXHAUSTED',error_message='Configured LLM budget prevented discovery.',updated_at=now() WHERE hierarchy_discovery_job_id=$1",[state.discovery_job_id]);await new PreAnalysisRequestRepository(client).mark(state.pre_analysis_request_id,{status:"paused_budget",discoveryStatus:"paused_budget",errorCode:"DISCOVERY_BUDGET_EXHAUSTED",errorMessage:"Configured LLM budget prevented hierarchy discovery."});return{outcome:"paused_budget",providerResultId:null,budgetPolicyId:budget.decision.budgetPolicyId};}
    if(!await repository.markProcessing(state.provider_job_id))throw new ProviderExecutionError("PROVIDER_JOB_TRANSITION_FAILED","Discovery provider job could not transition to processing");
    let execution:ProviderGeneratedOutput;
    try{execution=await adapter.execute({providerJobId:state.provider_job_id,provider:state.provider,model:state.model,promptText:state.prompt_text,promptType:`hierarchy_discovery_${state.discovery_stage}`,promptDepth:"weak",responseContractVersion:state.response_contract_version,structuredOutputMode:state.structured_output_mode,maximumOutputTokens:profile.maximumOutputTokens.weak,exactTargetName:context.targetName,discoveryStage:state.discovery_stage,discoveryCandidates:context.candidates,timeoutMs:this.timeoutMs});}
    catch(error){
      if (isProviderQuotaExhaustion(error) && state.discovery_attempt === 0 && job.fallback_provider && job.fallback_model && !job.fallback_attempted) {
        const fallbackProfile = providerModelProfile(job.fallback_provider, job.fallback_model);
        if (!fallbackProfile || !fallbackProfile.eligibleForDiscovery) throw new ProviderExecutionError("DISCOVERY_FALLBACK_UNAVAILABLE","Frozen discovery fallback profile is unavailable",true);
        await client.query("UPDATE provider_jobs SET status='failed',completed_at=now(),error_code=$2,error_message=$3,updated_at=now() WHERE provider_job_id=$1",[state.provider_job_id,error.code,error.message]);
        await client.query("UPDATE hierarchy_discovery_jobs SET fallback_attempted=true,updated_at=now() WHERE hierarchy_discovery_job_id=$1 AND fallback_attempted=false",[state.discovery_job_id]);
        const fallbackJob = await new ProviderJobRepository(client).createOrReuseDiscovery({
          discoveryJobId: state.discovery_job_id,
          discoveryAttempt: 1,
          provider: fallbackProfile.provider,
          model: fallbackProfile.model,
          responseContractVersion: state.response_contract_version,
          providerInstructionProfile: fallbackProfile.providerInstructionProfile,
          modelProfileVersion: fallbackProfile.modelProfileVersion,
          structuredOutputMode: fallbackProfile.preferredStructuredOutputMode,
          requestHash: state.request_hash!,
          requestPayload: state.request_payload
        });
        await new OutboxEventWriterRepository(client).createOrReuse({eventKey:`provider_job.fallback:${fallbackJob.provider_job_id}`,eventType:"provider_job.created",eventVersion:1,aggregateType:"provider_job",aggregateId:fallbackJob.provider_job_id,headers:{queueName:fallbackProfile.queueName},payload:{providerJobId:fallbackJob.provider_job_id}});
        return {outcome:"fallback_enqueued",providerResultId:null};
      }
      if(!(error instanceof ProviderExecutionError)||!error.invalidEvidence)throw error;execution=invalidExecution(error,state.model);
    }
    const validation=validateDiscoveryOutput({stage:state.discovery_stage,generatedContent:execution.generatedContent,candidateIds:context.candidates.map(v=>v.id),activeFrozenCandidateIds:active,maximumDiscoveredNames:state.user_id?5:3});
    const result=await saveEvidence(repository,state,execution,validation.valid?validation.validatedResponse:null,validation.validationErrors,validation.contextValidationStatus,budget.estimate);
    await repository.markSucceeded(state.provider_job_id);
    await new HierarchyDiscoveryResultService(client).apply(job,result.provider_result_id,validation.valid?validation.validatedResponse:null);
    return{outcome:"completed",providerResultId:result.provider_result_id};
  }
}

async function saveEvidence(repository:ProviderExecutionRepository,state:ProviderExecutionState,execution:ProviderGeneratedOutput,validatedResponse:JsonObject|null,validationErrors:any[],contextValidationStatus:"valid"|"invalid",estimate:{inputTokens:number;outputTokens:number}){
  const retained=retainGeneratedContent(execution.generatedContent);const result=await repository.createOrReuseProviderResult({providerJobId:state.provider_job_id,provider:state.provider,responseContractVersion:state.response_contract_version,modelVersion:execution.modelVersion??state.model,providerRequestId:execution.providerRequestId,...retained,providerMetadata:execution.sanitizedProviderMetadata,validatedResponse,validationErrors,contextValidationStatus,finishReason:execution.finishReason,latencyMs:execution.latencyMs});const inputTokens=execution.inputTokens??estimate.inputTokens;const outputTokens=execution.outputTokens??estimate.outputTokens;await repository.createOrReuseProviderActualUsage({providerJobId:state.provider_job_id,inputTokens,outputTokens,costMicros:estimateCostMicros({provider:state.provider,model:state.model,inputTokens,outputTokens,totalTokens:inputTokens+outputTokens})});return result;
}
function parseDiscoveryContext(payload:JsonObject,stage:string){const candidates=Array.isArray(payload.candidates)?payload.candidates.map(value=>{const row=value as Record<string,unknown>;if(typeof row.id!=="string"||typeof row.name!=="string")throw new ProviderExecutionError("DISCOVERY_CONTEXT_INVALID","Frozen discovery candidate is invalid",true);return{id:row.id,name:row.name};}):[];const target=payload.product??payload.brand??payload.category??payload.domain;const targetName=target&&typeof target==="object"&&!Array.isArray(target)&&typeof target.name==="string"?target.name:`${stage} discovery`;return{candidates,targetName};}
async function activeIds(database:DatabaseExecutor,table:string,column:string,ids:string[]){if(!ids.length)return new Set<string>();const result=await database.query<{id:string}>(`SELECT ${column} AS id FROM ${table} WHERE ${column}=ANY($1::bigint[]) AND is_active`,[ids]);return new Set(result.rows.map(row=>row.id));}
function invalidExecution(error:ProviderExecutionError,model:string):ProviderGeneratedOutput{return{generatedContent:typeof error.invalidEvidence!.rawResponse==="string"?error.invalidEvidence!.rawResponse:JSON.stringify(error.invalidEvidence!.rawResponse??null),sanitizedProviderMetadata:{transportValidationError:error.code},inputTokens:null,outputTokens:null,totalTokens:null,finishReason:null,providerRequestId:null,modelVersion:model,latencyMs:0};}
function isProviderQuotaExhaustion(error:unknown):error is ProviderExecutionError{return error instanceof ProviderExecutionError&&(error.code==="PROVIDER_CREDIT_EXHAUSTED"||error.code==="PROVIDER_QUOTA_EXHAUSTED");}
function targetName(payload:Record<string,unknown>){const context=payload.entityPathContext;if(context&&typeof context==="object"&&!Array.isArray(context)){for(const key of["useContext","product","brand","category","domain"]){const value=(context as Record<string,unknown>)[key];if(value&&typeof value==="object"&&!Array.isArray(value)&&typeof(value as Record<string,unknown>).name==="string")return(value as Record<string,string>).name;}}return"Unknown target";}
function snapshot(database:DatabaseExecutor,runId:string){return new ReportAggregationService(new ReportRepository(database)).createIfReady(runId);}
async function pauseNormal(repository:ProviderExecutionRepository,state:ProviderExecutionState){if(state.prompt_job_id===null||state.analysis_run_id===null)return;const ok=await repository.markBudgetPaused({providerJobId:state.provider_job_id,promptJobId:state.prompt_job_id,analysisRunId:state.analysis_run_id,reasonCode:"BUDGET_LIMIT_REACHED",reasonMessage:"Analysis paused because provider budget was reached before all prompts could execute."});if(!ok)throw new ProviderExecutionError("BUDGET_PAUSE_TRANSITION_FAILED","Provider work could not transition to paused_budget");}
