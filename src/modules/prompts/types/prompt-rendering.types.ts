import type {
  PromptDepth,
  PromptType
} from "../../../common/types/database.types.js";
import type { EntityPathContext } from "../contracts/entity-path-context.contract.js";

export type { EntityPathContext } from "../contracts/entity-path-context.contract.js";

export type PromptRenderingContext = {
  promptType: PromptType;
  promptDepth: PromptDepth;
  businessPromptVersion: string;
  responseContractVersion: string;
  entityPathContext: EntityPathContext;
};

export type PromptTemplate = (context: PromptRenderingContext) => string;
