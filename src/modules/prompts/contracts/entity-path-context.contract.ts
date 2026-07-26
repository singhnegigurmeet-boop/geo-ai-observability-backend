import { z } from "zod";

const entityPathLevels = [
  "domain",
  "category",
  "brand",
  "product",
  "use_context"
] as const;

const positiveDatabaseId = z.string().regex(/^[1-9]\d*$/);
const nonblankText = z.string().refine((value) => value.trim().length > 0, {
  message: "Value must not be blank"
});
const entityReferenceSchema = z
  .object({
    id: positiveDatabaseId,
    name: nonblankText
  })
  .strict();

const entityKeys = [
  "domain",
  "category",
  "brand",
  "product",
  "useContext"
] as const;

export const entityPathContextSchema = z
  .object({
    domain: entityReferenceSchema,
    category: entityReferenceSchema.optional(),
    brand: entityReferenceSchema.optional(),
    product: entityReferenceSchema.optional(),
    useContext: entityReferenceSchema.optional(),
    startingLevel: z.enum(entityPathLevels),
    targetLevel: z.enum(entityPathLevels),
    canonicalPath: nonblankText
  })
  .strict()
  .superRefine((value, context) => {
    const targetIndex = entityPathLevels.indexOf(value.targetLevel);
    const startingIndex = entityPathLevels.indexOf(value.startingLevel);

    for (const [index, key] of entityKeys.entries()) {
      const expected = index <= targetIndex;
      if (expected && value[key] === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required for targetLevel=${value.targetLevel}`
        });
      }
      if (!expected && value[key] !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is not allowed for targetLevel=${value.targetLevel}`
        });
      }
    }

    if (startingIndex > targetIndex) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["startingLevel"],
        message: "startingLevel cannot be deeper than targetLevel"
      });
    }
  });

export type EntityPathContext = z.infer<typeof entityPathContextSchema>;

export function entityPathTarget(
  context: EntityPathContext
): EntityPathContext["domain"] {
  return (
    context.useContext ??
    context.product ??
    context.brand ??
    context.category ??
    context.domain
  );
}
