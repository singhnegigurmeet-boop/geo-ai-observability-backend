import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import {
  getDefaultMigrationsDirectory,
  runMigrations
} from "../src/db/migration-runner.js";
import { ApplicationError } from "../src/errors/application-error.js";
import { AnonymousSessionRepository } from "../src/identity/anonymous-session.repository.js";
import { AnonymousSessionService } from "../src/identity/anonymous-session.service.js";
import { SessionTokenService } from "../src/identity/session-token.service.js";
import { AnalysisService } from "../src/analysis/analysis.service.js";
import { HierarchyRelationshipsRepository } from "../src/hierarchy/hierarchy-relationships.repository.js";
import type { OwnershipContext } from "../src/ownership/ownership-context.types.js";

const runIntegrationTests =
  process.env.RUN_PHASE45_INTEGRATION_TESTS === "true";
const pepper = "phase-45-integration-pepper-with-at-least-32-characters";

type Fixture = {
  domainId: string;
  categoryA: string;
  categoryB: string;
  categoryC: string;
  categoryMissing: string;
  categoryInactive: string;
  brandA: string;
  brandB: string;
  brandC: string;
  brandMissing: string;
  brandInactive: string;
  productA: string;
  productB: string;
  productC: string;
  productMissing: string;
  productInactive: string;
  contextA: string;
  contextB: string;
  contextC: string;
  contextMissing: string;
  contextInactive: string;
  domainCategoryA: string;
  domainCategoryB: string;
  domainCategoryC: string;
  domainCategoryInactive: string;
  categoryBrandA: string;
  categoryBrandB: string;
  categoryBrandC: string;
  categoryBrandInactive: string;
  brandProductA: string;
  brandProductB: string;
  brandProductC: string;
  brandProductInactive: string;
  productContextA: string;
  productContextB: string;
  productContextC: string;
  productContextInactive: string;
};

describe(
  "Phase 4.5 hierarchy relationships",
  { skip: !runIntegrationTests },
  () => {
    let pool: pg.Pool;
    let fixture: Fixture;
    let analyses: AnalysisService;
    let owner: OwnershipContext;

    before(async () => {
      const databaseUrl =
        process.env.TEST_DATABASE_URL ??
        "postgres://postgres:postgres@127.0.0.1:5433/geo_observability_test";
      pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
      const database = await pool.query<{ database_name: string }>(
        "SELECT current_database() AS database_name"
      );
      const databaseName = database.rows[0]?.database_name;
      if (!databaseName?.endsWith("_test")) {
        throw new Error(
          `Refusing to reset Phase 4.5 database without _test suffix: ${
            databaseName ?? "unknown"
          }`
        );
      }

      await pool.query("DROP SCHEMA IF EXISTS geo_meta CASCADE");
      await pool.query("DROP SCHEMA public CASCADE");
      await pool.query("CREATE SCHEMA public");
      await runMigrations({
        pool,
        migrationsDirectory: getDefaultMigrationsDirectory()
      });

      fixture = await seedFixture(pool);
      analyses = new AnalysisService(pool);
      const anonymousSessions = new AnonymousSessionService(
        new AnonymousSessionRepository(pool),
        pool,
        new SessionTokenService(pepper),
        { ttlSeconds: 3_600 }
      );
      const anonymous = await anonymousSessions.create();
      owner = {
        actorType: "anonymous",
        anonymousSessionId: anonymous.session.anonymous_session_id,
        userId: null,
        workspaceId: null
      };
    });

    after(async () => {
      await pool?.end();
    });

    it("creates four ID-only relationship tables and 31 production tables", async () => {
      const tables = await pool.query<{ table_name: string }>(
        `
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_type = 'BASE TABLE'
          ORDER BY table_name
        `
      );
      assert.equal(tables.rows.length, 31);
      for (const table of [
        "domain_categories",
        "category_brands",
        "brand_products",
        "product_use_contexts"
      ]) {
        assert.ok(tables.rows.some((row) => row.table_name === table));
      }

      const columns = await pool.query<{
        table_name: string;
        column_name: string;
      }>(
        `
          SELECT table_name, column_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = ANY($1::text[])
        `,
        [[
          "domain_categories",
          "category_brands",
          "brand_products",
          "product_use_contexts"
        ]]
      );
      const forbiddenColumns = new Set([
        "domain_name",
        "normalized_domain",
        "category_name",
        "brand_name",
        "product_name",
        "use_context_name",
        "normalized_name"
      ]);
      assert.equal(
        columns.rows.some((row) => forbiddenColumns.has(row.column_name)),
        false
      );
    });

    it("enforces uniqueness and the relationship foreign-key chain", async () => {
      await assertPostgresCode(
        pool.query(
          `
            INSERT INTO domain_categories (domain_id, category_id)
            VALUES ($1, $2)
          `,
          [fixture.domainId, fixture.categoryA]
        ),
        "23505"
      );
      await assertPostgresCode(
        pool.query(
          `
            INSERT INTO category_brands (domain_category_id, brand_id)
            VALUES ($1, $2)
          `,
          [fixture.domainCategoryA, fixture.brandA]
        ),
        "23505"
      );
      await assertPostgresCode(
        pool.query(
          `
            INSERT INTO brand_products (category_brand_id, product_id)
            VALUES ($1, $2)
          `,
          [fixture.categoryBrandA, fixture.productA]
        ),
        "23505"
      );
      await assertPostgresCode(
        pool.query(
          `
            INSERT INTO product_use_contexts (
              brand_product_id,
              use_context_id
            )
            VALUES ($1, $2)
          `,
          [fixture.brandProductA, fixture.contextA]
        ),
        "23505"
      );

      const missingId = "9223372036854775807";
      await assertPostgresCode(
        pool.query(
          `
            INSERT INTO domain_categories (domain_id, category_id)
            VALUES ($1, $2)
          `,
          [missingId, fixture.categoryA]
        ),
        "23503"
      );
      await assertPostgresCode(
        pool.query(
          `
            INSERT INTO domain_categories (domain_id, category_id)
            VALUES ($1, $2)
          `,
          [fixture.domainId, missingId]
        ),
        "23503"
      );
      await assertPostgresCode(
        pool.query(
          `
            INSERT INTO category_brands (domain_category_id, brand_id)
            VALUES ($1, $2)
          `,
          [missingId, fixture.brandA]
        ),
        "23503"
      );
      await assertPostgresCode(
        pool.query(
          `
            INSERT INTO category_brands (domain_category_id, brand_id)
            VALUES ($1, $2)
          `,
          [fixture.domainCategoryA, missingId]
        ),
        "23503"
      );
      await assertPostgresCode(
        pool.query(
          `
            INSERT INTO brand_products (category_brand_id, product_id)
            VALUES ($1, $2)
          `,
          [missingId, fixture.productA]
        ),
        "23503"
      );
      await assertPostgresCode(
        pool.query(
          `
            INSERT INTO brand_products (category_brand_id, product_id)
            VALUES ($1, $2)
          `,
          [fixture.categoryBrandA, missingId]
        ),
        "23503"
      );
      await assertPostgresCode(
        pool.query(
          `
            INSERT INTO product_use_contexts (
              brand_product_id,
              use_context_id
            )
            VALUES ($1, $2)
          `,
          [missingId, fixture.contextA]
        ),
        "23503"
      );
      await assertPostgresCode(
        pool.query(
          `
            INSERT INTO product_use_contexts (
              brand_product_id,
              use_context_id
            )
            VALUES ($1, $2)
          `,
          [fixture.brandProductA, missingId]
        ),
        "23503"
      );
    });

    it("finds only active relationship chains", async () => {
      const repository = new HierarchyRelationshipsRepository(pool);
      assert.equal(
        (
          await repository.findActiveDomainCategory(
            fixture.domainId,
            fixture.categoryA
          )
        )?.domain_category_id,
        fixture.domainCategoryA
      );
      assert.equal(
        await repository.findActiveDomainCategory(
          fixture.domainId,
          fixture.categoryInactive
        ),
        null
      );
      assert.equal(
        (
          await repository.findActiveCategoryBrand(
            fixture.domainCategoryA,
            fixture.brandA
          )
        )?.category_brand_id,
        fixture.categoryBrandA
      );
      assert.equal(
        await repository.findActiveCategoryBrand(
          fixture.domainCategoryA,
          fixture.brandInactive
        ),
        null
      );
      assert.equal(
        (
          await repository.findActiveBrandProduct(
            fixture.categoryBrandA,
            fixture.productA
          )
        )?.brand_product_id,
        fixture.brandProductA
      );
      assert.equal(
        await repository.findActiveBrandProduct(
          fixture.categoryBrandA,
          fixture.productInactive
        ),
        null
      );
      assert.equal(
        (
          await repository.findActiveProductUseContext(
            fixture.brandProductA,
            fixture.contextA
          )
        )?.product_use_context_id,
        fixture.productContextA
      );
      assert.equal(
        await repository.findActiveProductUseContext(
          fixture.brandProductA,
          fixture.contextInactive
        ),
        null
      );
    });

    it("orders active children by sort order, creation, and relationship ID", async () => {
      const repository = new HierarchyRelationshipsRepository(pool);
      assert.deepEqual(
        (await repository.listActiveCategories(fixture.domainId, 10)).map(
          (row) => row.domain_category_id
        ),
        [
          fixture.domainCategoryB,
          fixture.domainCategoryA,
          fixture.domainCategoryC
        ]
      );
      assert.deepEqual(
        (
          await repository.listActiveBrands(fixture.domainCategoryA, 10)
        ).map((row) => row.category_brand_id),
        [
          fixture.categoryBrandB,
          fixture.categoryBrandA,
          fixture.categoryBrandC
        ]
      );
      assert.deepEqual(
        (
          await repository.listActiveProducts(fixture.categoryBrandA, 10)
        ).map((row) => row.brand_product_id),
        [
          fixture.brandProductB,
          fixture.brandProductA,
          fixture.brandProductC
        ]
      );
      assert.deepEqual(
        (
          await repository.listActiveUseContexts(
            fixture.brandProductA,
            10
          )
        ).map((row) => row.product_use_context_id),
        [
          fixture.productContextB,
          fixture.productContextA,
          fixture.productContextC
        ]
      );
    });

    it("accepts domain-only and every active relationship depth", async () => {
      const requests = [
        { domain: "domain-only-45.example" },
        {
          domain: "relationships.example",
          categoryId: fixture.categoryA
        },
        {
          domain: "relationships.example",
          categoryId: fixture.categoryA,
          brandId: fixture.brandA
        },
        {
          domain: "relationships.example",
          categoryId: fixture.categoryA,
          brandId: fixture.brandA,
          productId: fixture.productA
        },
        {
          domain: "relationships.example",
          categoryId: fixture.categoryA,
          brandId: fixture.brandA,
          productId: fixture.productA,
          useContextId: fixture.contextA
        }
      ];

      for (const [index, request] of requests.entries()) {
        const result = await analyses.create(
          request,
          `phase45-valid-${index}`,
          owner
        );
        assert.equal(result.status, "queued");
      }
    });

    it("rejects missing and inactive relationships at every depth", async () => {
      const invalidRequests = [
        {
          domain: "relationships.example",
          categoryId: fixture.categoryMissing
        },
        {
          domain: "relationships.example",
          categoryId: fixture.categoryInactive
        },
        {
          domain: "relationships.example",
          categoryId: fixture.categoryA,
          brandId: fixture.brandMissing
        },
        {
          domain: "relationships.example",
          categoryId: fixture.categoryA,
          brandId: fixture.brandInactive
        },
        {
          domain: "relationships.example",
          categoryId: fixture.categoryA,
          brandId: fixture.brandA,
          productId: fixture.productMissing
        },
        {
          domain: "relationships.example",
          categoryId: fixture.categoryA,
          brandId: fixture.brandA,
          productId: fixture.productInactive
        },
        {
          domain: "relationships.example",
          categoryId: fixture.categoryA,
          brandId: fixture.brandA,
          productId: fixture.productA,
          useContextId: fixture.contextMissing
        },
        {
          domain: "relationships.example",
          categoryId: fixture.categoryA,
          brandId: fixture.brandA,
          productId: fixture.productA,
          useContextId: fixture.contextInactive
        }
      ];

      for (const [index, request] of invalidRequests.entries()) {
        await assert.rejects(
          analyses.create(
            request,
            `phase45-invalid-${index}`,
            owner
          ),
          hasCategory("VALIDATION_ERROR")
        );
      }
    });

    it("materializes paths without creating masters or relationship rows", async () => {
      const before = await controlledTableCounts(pool);
      const created = await analyses.create(
        {
          domain: "relationships.example",
          categoryId: fixture.categoryA,
          brandId: fixture.brandA
        },
        "phase45-materialize",
        owner
      );
      const replay = await analyses.create(
        {
          domain: "relationships.example",
          categoryId: fixture.categoryA,
          brandId: fixture.brandA
        },
        "phase45-materialize",
        owner
      );
      const after = await controlledTableCounts(pool);

      assert.deepEqual(after, before);
      assert.equal(replay.analysisRunId, created.analysisRunId);
      assert.equal(replay.idempotentReplay, true);

      const path = await pool.query<{ count: string }>(
        `
          SELECT count(*)
          FROM entity_paths
          WHERE entity_path_id = $1
            AND domain_id = $2
            AND category_id = $3
            AND brand_id = $4
            AND product_id IS NULL
            AND use_context_id IS NULL
        `,
        [
          created.startingEntityPathId,
          fixture.domainId,
          fixture.categoryA,
          fixture.brandA
        ]
      );
      assert.equal(path.rows[0]?.count, "1");

      const event = await pool.query<{
        headers: Record<string, unknown>;
        payload: Record<string, unknown>;
      }>(
        `
          SELECT headers, payload
          FROM outbox_events
          WHERE aggregate_type = 'analysis_run'
            AND aggregate_id = $1
        `,
        [created.analysisRunId]
      );
      assert.deepEqual(event.rows[0]?.headers, {
        queueName: "analysis_run_queue"
      });
      assert.deepEqual(
        Object.keys(event.rows[0]?.payload ?? {}).sort(),
        ["analysisRunId"]
      );
      const items = await pool.query<{ count: string }>(
        "SELECT count(*) FROM analysis_run_items"
      );
      assert.equal(items.rows[0]?.count, "0");
    });
  }
);

async function seedFixture(pool: pg.Pool): Promise<Fixture> {
  const domain = await pool.query<{ domain_id: string }>(
    `
      INSERT INTO domains (normalized_domain, display_domain)
      VALUES ('relationships.example', 'relationships.example')
      RETURNING domain_id
    `
  );
  const categories = await insertMasters(
    pool,
    "categories",
    "category_name",
    "category_id",
    "category",
    5
  );
  const brands = await insertMasters(
    pool,
    "brands",
    "brand_name",
    "brand_id",
    "brand",
    5
  );
  const products = await insertMasters(
    pool,
    "products",
    "product_name",
    "product_id",
    "product",
    5
  );
  const contexts = await insertMasters(
    pool,
    "use_contexts",
    "use_context_name",
    "use_context_id",
    "context",
    5
  );

  const domainId = domain.rows[0]!.domain_id;
  const domainCategories = await pool.query<{
    domain_category_id: string;
  }>(
    `
      INSERT INTO domain_categories (
        domain_id,
        category_id,
        is_active,
        sort_order,
        source
      )
      VALUES
        ($1, $2, true, 2, 'phase45'),
        ($1, $3, true, 1, 'phase45'),
        ($1, $4, true, NULL, 'phase45'),
        ($1, $5, false, 0, 'phase45')
      RETURNING domain_category_id
    `,
    [domainId, categories[0], categories[1], categories[2], categories[4]]
  );
  const categoryBrands = await pool.query<{
    category_brand_id: string;
  }>(
    `
      INSERT INTO category_brands (
        domain_category_id,
        brand_id,
        is_active,
        sort_order,
        source
      )
      VALUES
        ($1, $2, true, 2, 'phase45'),
        ($1, $3, true, 1, 'phase45'),
        ($1, $4, true, NULL, 'phase45'),
        ($1, $5, false, 0, 'phase45')
      RETURNING category_brand_id
    `,
    [
      domainCategories.rows[0]!.domain_category_id,
      brands[0],
      brands[1],
      brands[2],
      brands[4]
    ]
  );
  const brandProducts = await pool.query<{
    brand_product_id: string;
  }>(
    `
      INSERT INTO brand_products (
        category_brand_id,
        product_id,
        is_active,
        sort_order,
        source
      )
      VALUES
        ($1, $2, true, 2, 'phase45'),
        ($1, $3, true, 1, 'phase45'),
        ($1, $4, true, NULL, 'phase45'),
        ($1, $5, false, 0, 'phase45')
      RETURNING brand_product_id
    `,
    [
      categoryBrands.rows[0]!.category_brand_id,
      products[0],
      products[1],
      products[2],
      products[4]
    ]
  );
  const productContexts = await pool.query<{
    product_use_context_id: string;
  }>(
    `
      INSERT INTO product_use_contexts (
        brand_product_id,
        use_context_id,
        is_active,
        sort_order,
        source
      )
      VALUES
        ($1, $2, true, 2, 'phase45'),
        ($1, $3, true, 1, 'phase45'),
        ($1, $4, true, NULL, 'phase45'),
        ($1, $5, false, 0, 'phase45')
      RETURNING product_use_context_id
    `,
    [
      brandProducts.rows[0]!.brand_product_id,
      contexts[0],
      contexts[1],
      contexts[2],
      contexts[4]
    ]
  );

  return {
    domainId,
    categoryA: categories[0]!,
    categoryB: categories[1]!,
    categoryC: categories[2]!,
    categoryMissing: categories[3]!,
    categoryInactive: categories[4]!,
    brandA: brands[0]!,
    brandB: brands[1]!,
    brandC: brands[2]!,
    brandMissing: brands[3]!,
    brandInactive: brands[4]!,
    productA: products[0]!,
    productB: products[1]!,
    productC: products[2]!,
    productMissing: products[3]!,
    productInactive: products[4]!,
    contextA: contexts[0]!,
    contextB: contexts[1]!,
    contextC: contexts[2]!,
    contextMissing: contexts[3]!,
    contextInactive: contexts[4]!,
    domainCategoryA: domainCategories.rows[0]!.domain_category_id,
    domainCategoryB: domainCategories.rows[1]!.domain_category_id,
    domainCategoryC: domainCategories.rows[2]!.domain_category_id,
    domainCategoryInactive: domainCategories.rows[3]!.domain_category_id,
    categoryBrandA: categoryBrands.rows[0]!.category_brand_id,
    categoryBrandB: categoryBrands.rows[1]!.category_brand_id,
    categoryBrandC: categoryBrands.rows[2]!.category_brand_id,
    categoryBrandInactive: categoryBrands.rows[3]!.category_brand_id,
    brandProductA: brandProducts.rows[0]!.brand_product_id,
    brandProductB: brandProducts.rows[1]!.brand_product_id,
    brandProductC: brandProducts.rows[2]!.brand_product_id,
    brandProductInactive: brandProducts.rows[3]!.brand_product_id,
    productContextA:
      productContexts.rows[0]!.product_use_context_id,
    productContextB:
      productContexts.rows[1]!.product_use_context_id,
    productContextC:
      productContexts.rows[2]!.product_use_context_id,
    productContextInactive:
      productContexts.rows[3]!.product_use_context_id
  };
}

async function insertMasters(
  pool: pg.Pool,
  table: "categories" | "brands" | "products" | "use_contexts",
  nameColumn:
    | "category_name"
    | "brand_name"
    | "product_name"
    | "use_context_name",
  idColumn:
    | "category_id"
    | "brand_id"
    | "product_id"
    | "use_context_id",
  prefix: string,
  count: number
) {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const result = await pool.query<Record<string, string>>(
      `
        INSERT INTO ${table} (${nameColumn}, normalized_name)
        VALUES ($1, $2)
        RETURNING ${idColumn}
      `,
      [
        `${prefix} ${index + 1}`,
        `phase45-${prefix}-${index + 1}`
      ]
    );
    ids.push(result.rows[0]![idColumn] as string);
  }
  return ids;
}

async function controlledTableCounts(pool: pg.Pool) {
  const tables = [
    "categories",
    "brands",
    "products",
    "use_contexts",
    "domain_categories",
    "category_brands",
    "brand_products",
    "product_use_contexts"
  ];
  const counts: Record<string, string> = {};
  for (const table of tables) {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*) FROM ${table}`
    );
    counts[table] = result.rows[0]!.count;
  }
  return counts;
}

async function assertPostgresCode(
  promise: Promise<unknown>,
  code: string
) {
  await assert.rejects(
    promise,
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === code
  );
}

function hasCategory(category: ApplicationError["category"]) {
  return (error: unknown) =>
    error instanceof ApplicationError && error.category === category;
}
