import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OwnershipContext } from "../../../src/common/ownership/ownership-context.types.js";
import { CanonicalAnalysisPlannerService } from "../../../src/modules/analysis/services/canonical-analysis-planner.service.js";

const owner: OwnershipContext = {
  actorType: "anonymous",
  anonymousSessionId: "91",
  userId: null,
  workspaceId: null
};

describe("canonical analysis planner", () => {
  it("uses deterministic classification uncertainty and exact multiplication without writes", async () => {
    const statements: string[] = [];
    const database = fakeDatabase(statements, 10);
    const planner = new CanonicalAnalysisPlannerService(database as never);
    const plan = await planner.plan({ domain: "New.Example." }, owner);

    assert.deepEqual(plan.estimatedEligibleCategories, {
      minimum: 0,
      maximum: 3
    });
    assert.deepEqual(
      plan.expectedExecutions.normalProviderJobCountEstimate,
      { minimum: 0, maximum: 9 }
    );
    assert.equal(
      plan.expectedExecutions.classificationProviderJobCount,
      1
    );
    assert.deepEqual(
      plan.expectedExecutions.totalProviderJobCountEstimate,
      { minimum: 1, maximum: 10 }
    );
    assert.equal(plan.classificationRequired, true);
    assert.equal(
      statements.some((statement) =>
        /\b(INSERT|UPDATE|DELETE)\b/i.test(statement)
      ),
      false
    );
  });

  it("produces the same canonical hash for repeated planning and changes it for a category set change", async () => {
    const database = fakeDatabase([], 3);
    const planner = new CanonicalAnalysisPlannerService(database as never);
    const first = await planner.plan(
      {
        domain: "identity.example",
        categorySelection: { mode: "selected", categoryIds: ["1", "2"] }
      },
      owner
    );
    const replay = await planner.plan(
      {
        domain: "IDENTITY.EXAMPLE.",
        categorySelection: { mode: "selected", categoryIds: ["1", "2"] }
      },
      owner
    );
    const changed = await planner.plan(
      {
        domain: "identity.example",
        categorySelection: { mode: "selected", categoryIds: ["1", "3"] }
      },
      owner
    );
    assert.equal(first.canonicalRequestHash, replay.canonicalRequestHash);
    assert.notEqual(first.canonicalRequestHash, changed.canonicalRequestHash);
  });
});

function fakeDatabase(statements: string[], categoryCount: number) {
  return {
    async query(statement: string, values?: unknown[]) {
      statements.push(statement);
      if (statement.includes("FROM categories")) {
        const selected = Array.isArray(values?.[0])
          ? (values?.[0] as string[])
          : Array.from({ length: categoryCount }, (_, index) =>
              String(index + 1)
            );
        return {
          rows: selected.map((id) => ({
            category_id: id,
            category_name: `Category ${id}`,
            normalized_name: `category-${id}`,
            description: null,
            is_active: true,
            created_at: new Date(0),
            updated_at: new Date(0)
          }))
        };
      }
      if (statement.includes("FROM domains")) return { rows: [] };
      throw new Error(`Unexpected read query: ${statement}`);
    }
  };
}
