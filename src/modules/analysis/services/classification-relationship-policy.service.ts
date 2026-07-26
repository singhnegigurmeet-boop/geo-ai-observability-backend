export type ExistingDomainCategoryRelationship = {
  isActive: boolean;
  source: "manual" | "import" | "llm_classification";
};

export type ClassificationRelationshipAction =
  | "create"
  | "reactivate"
  | "reuse";

export function classificationRelationshipAction(
  existing: ExistingDomainCategoryRelationship | null
): ClassificationRelationshipAction {
  if (existing === null) return "create";
  return existing.isActive ? "reuse" : "reactivate";
}
