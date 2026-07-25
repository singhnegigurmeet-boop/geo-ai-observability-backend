import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  QueryResult,
  QueryResultRow
} from "pg";
import type { DatabaseExecutor } from "../../../src/common/database/database-executor.js";
import { HierarchyRelationshipsRepository } from "../../../src/modules/hierarchy/repositories/hierarchy-relationships.repository.js";

class RecordingDatabase implements DatabaseExecutor {
  readonly statements: string[] = [];

  async query<TRow extends QueryResultRow = QueryResultRow>(
    text: string
  ): Promise<QueryResult<TRow>> {
    this.statements.push(text.replace(/\s+/g, " ").trim());
    return {
      command: "SELECT",
      rowCount: 0,
      oid: 0,
      fields: [],
      rows: []
    };
  }
}

describe("hierarchy relationship repository", () => {
  it("filters active relationship lookups", async () => {
    const database = new RecordingDatabase();
    const repository = new HierarchyRelationshipsRepository(database);

    await repository.findActiveDomainCategory("1", "2");
    await repository.findActiveCategoryBrand("3", "4");
    await repository.findActiveBrandProduct("5", "6");
    await repository.findActiveProductUseContext("7", "8");

    assert.equal(database.statements.length, 4);
    for (const statement of database.statements) {
      assert.match(statement, /relationship\.is_active/);
      assert.match(statement, /parent\.is_active|domain\.is_active/);
    }
  });

  it("uses deterministic admin-controlled ordering for every child list", async () => {
    const database = new RecordingDatabase();
    const repository = new HierarchyRelationshipsRepository(database);

    await repository.listActiveCategories("1", 5);
    await repository.listActiveBrands("2", 5);
    await repository.listActiveProducts("3", 5);
    await repository.listActiveUseContexts("4", 5);

    assert.equal(database.statements.length, 4);
    for (const statement of database.statements) {
      assert.match(
        statement,
        /ORDER BY relationship\.sort_order ASC NULLS LAST, relationship\.created_at ASC, relationship\.(?:domain_category_id|category_brand_id|brand_product_id|product_use_context_id) ASC/
      );
      assert.match(statement, /LIMIT \$2/);
    }
  });
});
