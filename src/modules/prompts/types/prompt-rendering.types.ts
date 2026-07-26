import type {
  EntityPathType,
  PromptDepth,
  PromptType
} from "../../../common/types/database.types.js";

export type EntityPathContext = {
  domain: { id: string; name: string };
  category?: { id: string; name: string };
  brand?: { id: string; name: string };
  product?: { id: string; name: string };
  useContext?: { id: string; name: string };
  startingLevel: EntityPathType;
  targetLevel: EntityPathType;
  canonicalPath: string;
};

export type PromptRenderingContext = {
  promptType: PromptType;
  promptDepth: PromptDepth;
  businessPromptVersion: string;
  responseContractVersion: string;
  entityPathContext: EntityPathContext;
};

export type PromptTemplate = (context: PromptRenderingContext) => string;
