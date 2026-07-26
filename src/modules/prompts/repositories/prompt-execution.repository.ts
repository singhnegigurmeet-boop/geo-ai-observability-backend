import type { DatabaseExecutor } from "../../../common/database/database-executor.js";
import type {
  EntityPathType,
  JobStatus,
  JsonObject,
  PromptDepth,
  PromptType
} from "../../../common/types/database.types.js";

export type PromptExecutionState = {
  prompt_job_id: string;
  llm_run_id: string;
  prompt_type: PromptType;
  prompt_depth: PromptDepth;
  business_prompt_version: string;
  response_contract_version: string;
  input_payload: JsonObject;
  prompt_status: JobStatus;
  prompt_text: string | null;
  analysis_run_item_id: string;
  analysis_run_id: string;
  entity_path_id: string;
  starting_entity_path_id: string;
  user_id: string | null;
  workspace_id: string | null;
  anonymous_session_id: string | null;
  path_type: EntityPathType;
  normalized_domain: string;
  category_name: string | null;
  brand_name: string | null;
  product_name: string | null;
  use_context_name: string | null;
};

export class PromptExecutionRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async findForUpdate(promptJobId: string) {
    const result = await this.database.query<PromptExecutionState>(
      `
        SELECT
          prompt.prompt_job_id,
          prompt.llm_run_id,
          prompt.prompt_type,
          prompt.prompt_depth,
          prompt.business_prompt_version,
          prompt.response_contract_version,
          prompt.input_payload,
          prompt.status AS prompt_status,
          prompt.prompt_text,
          item.analysis_run_item_id,
          run.analysis_run_id,
          path.entity_path_id,
          run.starting_entity_path_id,
          run.user_id,
          run.workspace_id,
          run.anonymous_session_id,
          path.path_type,
          domain.normalized_domain,
          category.category_name,
          brand.brand_name,
          product.product_name,
          use_context.use_context_name
        FROM prompt_jobs AS prompt
        JOIN llm_runs AS llm ON llm.llm_run_id = prompt.llm_run_id
        JOIN analysis_run_items AS item
          ON item.analysis_run_item_id = llm.analysis_run_item_id
        JOIN analysis_runs AS run
          ON run.analysis_run_id = item.analysis_run_id
        JOIN entity_paths AS path
          ON path.entity_path_id = item.entity_path_id AND path.is_active
        JOIN domains AS domain ON domain.domain_id = path.domain_id
        LEFT JOIN categories AS category
          ON category.category_id = path.category_id
        LEFT JOIN brands AS brand ON brand.brand_id = path.brand_id
        LEFT JOIN products AS product ON product.product_id = path.product_id
        LEFT JOIN use_contexts AS use_context
          ON use_context.use_context_id = path.use_context_id
        WHERE prompt.prompt_job_id = $1
        FOR UPDATE OF prompt
      `,
      [promptJobId]
    );
    return result.rows[0] ?? null;
  }

  async markRenderedProcessing(promptJobId: string, promptText: string) {
    const result = await this.database.query<{ prompt_job_id: string }>(
      `
        UPDATE prompt_jobs
        SET prompt_text = $2,
            status = 'processing',
            started_at = COALESCE(started_at, now()),
            completed_at = NULL,
            error_code = NULL,
            error_message = NULL,
            updated_at = now()
        WHERE prompt_job_id = $1
          AND status = 'pending'
          AND prompt_text IS NULL
        RETURNING prompt_job_id
      `,
      [promptJobId, promptText]
    );
    return result.rows[0] ?? null;
  }

}
