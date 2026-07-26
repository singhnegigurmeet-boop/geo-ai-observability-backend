import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { entityPathContextSchema } from "../../../src/modules/prompts/contracts/entity-path-context.contract.js";

const entities = {
  domain: { id: "1", name: "example.com" },
  category: { id: "2", name: "Analytics" },
  brand: { id: "3", name: "Acme" },
  product: { id: "4", name: "Observer" },
  useContext: { id: "5", name: "Enterprise monitoring" }
};

const levels = [
  "domain",
  "category",
  "brand",
  "product",
  "use_context"
] as const;

describe("EntityPathContext runtime contract", () => {
  for (const [index, targetLevel] of levels.entries()) {
    it(`accepts a valid ${targetLevel} path`, () => {
      const value = contextAt(index);
      assert.equal(entityPathContextSchema.safeParse(value).success, true);
    });
  }

  const invalidCases: Array<[string, () => Record<string, unknown>]> = [
    ["missing domain", () => omit(contextAt(0), "domain")],
    ["missing required parent", () => omit(contextAt(3), "category")],
    [
      "unexpected deeper child",
      () => ({ ...contextAt(1), brand: entities.brand })
    ],
    [
      "hierarchy gap",
      () => ({ ...omit(contextAt(4), "brand"), product: entities.product })
    ],
    ["blank canonicalPath", () => ({ ...contextAt(0), canonicalPath: " " })],
    [
      "invalid startingLevel",
      () => ({ ...contextAt(0), startingLevel: "company" })
    ],
    [
      "invalid targetLevel",
      () => ({ ...contextAt(0), targetLevel: "company" })
    ],
    [
      "targetLevel/entity mismatch",
      () => ({ ...contextAt(2), targetLevel: "category" })
    ],
    ["unknown fields", () => ({ ...contextAt(0), extra: true })],
    [
      "non-positive ID",
      () => ({ ...contextAt(0), domain: { id: "0", name: "example.com" } })
    ],
    [
      "blank entity name",
      () => ({ ...contextAt(0), domain: { id: "1", name: " " } })
    ],
    [
      "starting level deeper than target",
      () => ({ ...contextAt(1), startingLevel: "brand" })
    ]
  ];

  for (const [name, build] of invalidCases) {
    it(`rejects ${name}`, () => {
      assert.equal(entityPathContextSchema.safeParse(build()).success, false);
    });
  }
});

function contextAt(targetIndex: number) {
  const value: Record<string, unknown> = {
    domain: entities.domain,
    startingLevel: "domain",
    targetLevel: levels[targetIndex],
    canonicalPath: [
      entities.domain.name,
      entities.category.name,
      entities.brand.name,
      entities.product.name,
      entities.useContext.name
    ]
      .slice(0, targetIndex + 1)
      .join(" > ")
  };
  if (targetIndex >= 1) value.category = entities.category;
  if (targetIndex >= 2) value.brand = entities.brand;
  if (targetIndex >= 3) value.product = entities.product;
  if (targetIndex >= 4) value.useContext = entities.useContext;
  return value;
}

function omit(value: Record<string, unknown>, key: string) {
  const copy = { ...value };
  delete copy[key];
  return copy;
}
