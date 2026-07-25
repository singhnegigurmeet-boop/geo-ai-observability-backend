import type { EntityPathType, PromptType } from "../types/database.types.js";

export type PromptRenderingContext = {
  promptType: PromptType;
  promptVersion: "v1" | "v1_light";
  actorType: "anonymous" | "user";
  normalizedDomain: string;
  pathType: EntityPathType;
  categoryName: string | null;
  brandName: string | null;
  productName: string | null;
  useContextName: string | null;
};

export type PromptTemplate = (context: PromptRenderingContext) => string;
