import type { DatabaseExecutor } from "../../../common/database/database-executor.js";
import type {
  EntityPathType,
  JsonObject,
  PromptDepth,
  PromptType
} from "../../../common/types/database.types.js";
import {
  entityPathContextSchema,
  type EntityPathContext
} from "../../prompts/contracts/entity-path-context.contract.js";

export type AuthoritativeContextErrorCode =
  | "ENTITY_PATH_RELATIONSHIP_INVALID"
  | "ENTITY_PATH_ENTITY_INACTIVE"
  | "ENTITY_PATH_NOT_FOUND";

export type AuthoritativeEntityPathContextResult =
  | {
      valid: true;
      context: EntityPathContext;
      promptInputPayload: JsonObject;
      promptType: PromptType;
      promptDepth: PromptDepth;
      responseContractVersion: string;
    }
  | {
      valid: false;
      context: null;
      errors: Array<{
        layer: "postgres_context";
        code: AuthoritativeContextErrorCode;
        message: string;
      }>;
    };

type ContextRecord = {
  job_kind: string;
  prompt_job_id: string | null;
  resolved_prompt_job_id: string | null;
  input_payload: JsonObject | null;
  prompt_type: PromptType | null;
  prompt_depth: PromptDepth | null;
  prompt_contract_version: string | null;
  provider_contract_version: string;
  entity_path_id: string | null;
  path_type: EntityPathType | null;
  path_is_active: boolean | null;
  domain_id: string | null;
  category_id: string | null;
  brand_id: string | null;
  product_id: string | null;
  use_context_id: string | null;
  starting_path_type: EntityPathType | null;
  starting_path_is_active: boolean | null;
  starting_domain_id: string | null;
  starting_category_id: string | null;
  starting_brand_id: string | null;
  starting_product_id: string | null;
  starting_use_context_id: string | null;
  normalized_domain: string | null;
  domain_is_active: boolean | null;
  category_name: string | null;
  category_is_active: boolean | null;
  brand_name: string | null;
  brand_is_active: boolean | null;
  product_name: string | null;
  product_is_active: boolean | null;
  use_context_name: string | null;
  use_context_is_active: boolean | null;
  domain_category_id: string | null;
  domain_category_is_active: boolean | null;
  category_brand_id: string | null;
  category_brand_is_active: boolean | null;
  brand_product_id: string | null;
  brand_product_is_active: boolean | null;
  product_use_context_id: string | null;
  product_use_context_is_active: boolean | null;
};

export class AuthoritativeEntityPathContextRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async loadForProviderJob(
    providerJobId: string
  ): Promise<AuthoritativeEntityPathContextResult> {
    const result = await this.database.query<ContextRecord>(
      `
        SELECT
          job.job_kind,
          job.prompt_job_id,
          prompt.prompt_job_id AS resolved_prompt_job_id,
          prompt.input_payload,
          prompt.prompt_type,
          prompt.prompt_depth,
          prompt.response_contract_version AS prompt_contract_version,
          job.response_contract_version AS provider_contract_version,
          path.entity_path_id,
          path.path_type,
          path.is_active AS path_is_active,
          path.domain_id,
          path.category_id,
          path.brand_id,
          path.product_id,
          path.use_context_id,
          starting_path.path_type AS starting_path_type,
          starting_path.is_active AS starting_path_is_active,
          starting_path.domain_id AS starting_domain_id,
          starting_path.category_id AS starting_category_id,
          starting_path.brand_id AS starting_brand_id,
          starting_path.product_id AS starting_product_id,
          starting_path.use_context_id AS starting_use_context_id,
          domain.normalized_domain,
          domain.is_active AS domain_is_active,
          category.category_name,
          category.is_active AS category_is_active,
          brand.brand_name,
          brand.is_active AS brand_is_active,
          product.product_name,
          product.is_active AS product_is_active,
          use_context.use_context_name,
          use_context.is_active AS use_context_is_active,
          domain_category.domain_category_id,
          domain_category.is_active AS domain_category_is_active,
          category_brand.category_brand_id,
          category_brand.is_active AS category_brand_is_active,
          brand_product.brand_product_id,
          brand_product.is_active AS brand_product_is_active,
          product_use_context.product_use_context_id,
          product_use_context.is_active AS product_use_context_is_active
        FROM provider_jobs AS job
        LEFT JOIN prompt_jobs AS prompt
          ON prompt.prompt_job_id = job.prompt_job_id
        LEFT JOIN llm_runs AS llm
          ON llm.llm_run_id = prompt.llm_run_id
        LEFT JOIN analysis_run_items AS item
          ON item.analysis_run_item_id = llm.analysis_run_item_id
        LEFT JOIN analysis_runs AS run
          ON run.analysis_run_id = item.analysis_run_id
        LEFT JOIN entity_paths AS path
          ON path.entity_path_id = item.entity_path_id
        LEFT JOIN entity_paths AS starting_path
          ON starting_path.entity_path_id = run.starting_entity_path_id
        LEFT JOIN domains AS domain
          ON domain.domain_id = path.domain_id
        LEFT JOIN categories AS category
          ON category.category_id = path.category_id
        LEFT JOIN domain_categories AS domain_category
          ON domain_category.domain_id = path.domain_id
         AND domain_category.category_id = path.category_id
        LEFT JOIN brands AS brand
          ON brand.brand_id = path.brand_id
        LEFT JOIN category_brands AS category_brand
          ON category_brand.domain_category_id =
             domain_category.domain_category_id
         AND category_brand.brand_id = path.brand_id
        LEFT JOIN products AS product
          ON product.product_id = path.product_id
        LEFT JOIN brand_products AS brand_product
          ON brand_product.category_brand_id =
             category_brand.category_brand_id
         AND brand_product.product_id = path.product_id
        LEFT JOIN use_contexts AS use_context
          ON use_context.use_context_id = path.use_context_id
        LEFT JOIN product_use_contexts AS product_use_context
          ON product_use_context.brand_product_id =
             brand_product.brand_product_id
         AND product_use_context.use_context_id = path.use_context_id
        WHERE job.provider_job_id = $1
      `,
      [providerJobId]
    );
    const row = result.rows[0];
    if (
      !row ||
      row.job_kind !== "normal_prompt" ||
      row.prompt_job_id === null ||
      row.resolved_prompt_job_id !== row.prompt_job_id ||
      row.input_payload === null ||
      row.prompt_type === null ||
      row.prompt_depth === null ||
      row.prompt_contract_version === null ||
      row.entity_path_id === null ||
      row.path_type === null ||
      row.starting_path_type === null ||
      row.domain_id === null ||
      row.normalized_domain === null
    ) {
      return invalid(
        "ENTITY_PATH_NOT_FOUND",
        "The normal provider job entity path lineage is incomplete"
      );
    }

    if (
      row.path_is_active !== true ||
      row.starting_path_is_active !== true ||
      row.domain_is_active !== true ||
      (row.category_id !== null && row.category_is_active !== true) ||
      (row.brand_id !== null && row.brand_is_active !== true) ||
      (row.product_id !== null && row.product_is_active !== true) ||
      (row.use_context_id !== null && row.use_context_is_active !== true)
    ) {
      return invalid(
        "ENTITY_PATH_ENTITY_INACTIVE",
        "The entity path contains an inactive taxonomy entity"
      );
    }

    if (
      (row.category_id !== null &&
        (row.domain_category_id === null ||
          row.domain_category_is_active !== true)) ||
      (row.brand_id !== null &&
        (row.category_brand_id === null ||
          row.category_brand_is_active !== true)) ||
      (row.product_id !== null &&
        (row.brand_product_id === null ||
          row.brand_product_is_active !== true)) ||
      (row.use_context_id !== null &&
        (row.product_use_context_id === null ||
          row.product_use_context_is_active !== true)) ||
      !startingPathIsPrefix(row)
    ) {
      return invalid(
        "ENTITY_PATH_RELATIONSHIP_INVALID",
        "The entity path hierarchy relationship chain is invalid"
      );
    }

    const context: Record<string, unknown> = {
      domain: { id: row.domain_id, name: row.normalized_domain },
      startingLevel: row.starting_path_type,
      targetLevel: row.path_type,
      canonicalPath: [
        row.normalized_domain,
        row.category_name,
        row.brand_name,
        row.product_name,
        row.use_context_name
      ]
        .filter((part): part is string => part !== null)
        .join(" > ")
    };
    if (row.category_id !== null && row.category_name !== null) {
      context.category = { id: row.category_id, name: row.category_name };
    }
    if (row.brand_id !== null && row.brand_name !== null) {
      context.brand = { id: row.brand_id, name: row.brand_name };
    }
    if (row.product_id !== null && row.product_name !== null) {
      context.product = { id: row.product_id, name: row.product_name };
    }
    if (row.use_context_id !== null && row.use_context_name !== null) {
      context.useContext = {
        id: row.use_context_id,
        name: row.use_context_name
      };
    }
    const parsed = entityPathContextSchema.safeParse(context);
    if (!parsed.success) {
      return invalid(
        "ENTITY_PATH_RELATIONSHIP_INVALID",
        "The authoritative entity path does not satisfy its hierarchy shape"
      );
    }
    if (row.prompt_contract_version !== row.provider_contract_version) {
      return invalid(
        "ENTITY_PATH_RELATIONSHIP_INVALID",
        "The provider job is not bound to the prompt response contract"
      );
    }
    return {
      valid: true,
      context: parsed.data,
      promptInputPayload: row.input_payload,
      promptType: row.prompt_type,
      promptDepth: row.prompt_depth,
      responseContractVersion: row.prompt_contract_version
    };
  }
}

function startingPathIsPrefix(row: ContextRecord) {
  if (
    row.starting_path_type === null ||
    row.starting_domain_id !== row.domain_id
  ) {
    return false;
  }
  const levels: Array<{
    level: EntityPathType;
    starting: string | null;
    target: string | null;
  }> = [
    {
      level: "category",
      starting: row.starting_category_id,
      target: row.category_id
    },
    { level: "brand", starting: row.starting_brand_id, target: row.brand_id },
    {
      level: "product",
      starting: row.starting_product_id,
      target: row.product_id
    },
    {
      level: "use_context",
      starting: row.starting_use_context_id,
      target: row.use_context_id
    }
  ];
  const levelOrder: EntityPathType[] = [
    "domain",
    "category",
    "brand",
    "product",
    "use_context"
  ];
  const startingIndex = levelOrder.indexOf(row.starting_path_type);
  const targetIndex =
    row.path_type === null ? -1 : levelOrder.indexOf(row.path_type);
  if (startingIndex < 0 || targetIndex < 0 || startingIndex > targetIndex) {
    return false;
  }
  return levels.every(
    ({ level, starting, target }) =>
      levelOrder.indexOf(level) > startingIndex || starting === target
  );
}

function invalid(
  code: AuthoritativeContextErrorCode,
  message: string
): AuthoritativeEntityPathContextResult {
  return {
    valid: false,
    context: null,
    errors: [{ layer: "postgres_context", code, message }]
  };
}
