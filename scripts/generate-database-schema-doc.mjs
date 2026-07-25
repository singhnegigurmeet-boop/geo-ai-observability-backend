import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationPath = resolve(root, "src/common/database/migrations/001_v6_final_baseline.sql");
const outputPath = resolve(root, "DATABASE_SCHEMA.md");
const sql = await readFile(migrationPath, "utf8");

const purpose = {
  users: "Stores registered user identities, login-facing profile data, and account lifecycle state.",
  user_sessions: "Stores hashed authentication sessions for registered users, including expiry and revocation state.",
  anonymous_sessions: "Stores hashed guest sessions and the immutable claim that transfers a guest session to a registered user and workspace.",
  workspaces: "Represents tenant/workspace boundaries. Every workspace records the user who created it.",
  workspace_members: "Joins users to workspaces and assigns the effective workspace role used by authorization.",
  workspace_role_change_requests: "Records auditable requests to change a member's workspace role, including requester, reviewer, outcome, and notes.",
  domains: "Canonical catalog of normalized internet domains that form the root of the analysis hierarchy.",
  categories: "Canonical catalog of normalized product or business categories.",
  brands: "Canonical catalog of normalized brands.",
  products: "Canonical catalog of normalized products.",
  use_contexts: "Canonical catalog of normalized product use cases or contexts.",
  domain_categories: "Links a category to a domain and stores activation, ordering, and provenance metadata for that hierarchy edge.",
  category_brands: "Links a brand to a domain/category pair and stores activation, ordering, and provenance metadata.",
  brand_products: "Links a product to a domain/category/brand branch through `category_brands`.",
  product_use_contexts: "Links a use context to a product branch through `brand_products`.",
  entity_paths: "Materializes valid hierarchy paths (domain through optional category, brand, product, and use context) for stable selection and analysis references.",
  analysis_runs: "Top-level analysis request and lifecycle record, owned either by a guest session or by a user/workspace membership.",
  analysis_run_items: "Expands one analysis run into ordered work items, one per selected materialized entity path.",
  analysis_run_provider_models: "Immutable snapshot of the ordered provider/model choices used by an analysis run.",
  llm_runs: "Groups prompt-generation and provider work for one analysis item; `run_key` permits distinct runs such as the primary run.",
  prompt_jobs: "Stores prompt planning/rendering jobs, rendered prompt text, input context, priority, attempts, and execution state.",
  provider_jobs: "Stores one provider/model execution job for a rendered prompt and tracks retry and execution state.",
  provider_results: "Immutable raw and parsed response evidence returned by a provider, including validation outcome and latency.",
  provider_scores: "Immutable, versioned score calculated from one provider result, with component-level scoring evidence.",
  token_usage: "Immutable estimated or actual token/cost ledger entries for provider jobs; used for accounting and budget enforcement.",
  reports: "Immutable, versioned report revisions aggregated from an analysis run's provider outcomes and scores.",
  budget_policies: "Defines enabled hard or soft token/cost limits at platform, workspace, user, guest-session, or analysis-run scope.",
  scheduler_jobs: "Defines recurring workspace-owned analysis schedules and tracks the next/last enqueue state.",
  notifications: "Durable notification delivery records for users/workspaces or administrators, with retry and delivery state.",
  outbox_events: "Transactional outbox used to publish database changes reliably to RabbitMQ without losing events between commit and publish.",
  failure_records: "Operational dead-letter/failure ledger for queue messages, including attempt, diagnostics, acknowledgement, and resolution state.",
};

const group = {
  "Identity and tenancy": ["users", "user_sessions", "anonymous_sessions", "workspaces", "workspace_members", "workspace_role_change_requests"],
  "Entity hierarchy": ["domains", "categories", "brands", "products", "use_contexts", "domain_categories", "category_brands", "brand_products", "product_use_contexts", "entity_paths"],
  "Analysis execution": ["analysis_runs", "analysis_run_items", "analysis_run_provider_models", "llm_runs", "prompt_jobs", "provider_jobs"],
  "Evidence, scoring, and reporting": ["provider_results", "provider_scores", "token_usage", "reports"],
  "Budgets, scheduling, and reliability": ["budget_policies", "scheduler_jobs", "notifications", "outbox_events", "failure_records"],
};

const enumMatches = [...sql.matchAll(/CREATE TYPE public\.(\w+) AS ENUM \(\s*([\s\S]*?)\s*\);/g)];
const enums = new Map(enumMatches.map((match) => [
  match[1],
  [...match[2].matchAll(/'([^']+)'/g)].map((value) => value[1]),
]));

const tableMatches = [...sql.matchAll(/CREATE TABLE public\.(\w+) \(\s*([\s\S]*?)\n\);/g)];
const tables = new Map(tableMatches.map((match) => [match[1], match[2]]));

const primaryKeys = new Map(
  [...sql.matchAll(/ALTER TABLE ONLY public\.(\w+)\s+ADD CONSTRAINT \S+ PRIMARY KEY \(([^)]+)\);/g)]
    .map((match) => [match[1], match[2]])
);

const uniqueConstraints = new Map();
for (const match of sql.matchAll(/ALTER TABLE ONLY public\.(\w+)\s+ADD CONSTRAINT \S+ UNIQUE( NULLS NOT DISTINCT)? \(([^)]+)\);/g)) {
  const values = uniqueConstraints.get(match[1]) ?? [];
  values.push(`(${match[3]})${match[2] ? " NULLS NOT DISTINCT" : ""}`);
  uniqueConstraints.set(match[1], values);
}
for (const match of sql.matchAll(/CREATE UNIQUE INDEX \S+ ON public\.(\w+)[\s\S]*?\(([^;\n]+)\)(?: WHERE ([^;]+))?;/g)) {
  const values = uniqueConstraints.get(match[1]) ?? [];
  values.push(`(${match[2]})${match[3] ? ` WHERE ${match[3]}` : ""}`);
  uniqueConstraints.set(match[1], values);
}

const indexes = new Map();
for (const match of sql.matchAll(/CREATE (UNIQUE )?INDEX (\S+) ON public\.(\w+) USING (\w+) \(([^;\n]+)\)(?: WHERE ([^;]+))?;/g)) {
  const values = indexes.get(match[3]) ?? [];
  values.push({
    name: match[2],
    unique: Boolean(match[1]),
    method: match[4],
    expression: match[5],
    predicate: match[6],
  });
  indexes.set(match[3], values);
}

const foreignKeys = new Map();
for (const match of sql.matchAll(/ALTER TABLE ONLY public\.(\w+)\s+ADD CONSTRAINT \S+ FOREIGN KEY \(([^)]+)\) REFERENCES public\.(\w+)\(([^)]+)\)(?: MATCH FULL)? ON DELETE (\w+);/g)) {
  const values = foreignKeys.get(match[1]) ?? [];
  values.push({ columns: match[2], targetTable: match[3], targetColumns: match[4], onDelete: match[5] });
  foreignKeys.set(match[1], values);
}

const triggers = new Map();
for (const match of sql.matchAll(/CREATE TRIGGER (\S+) ([\s\S]*?) ON public\.(\w+) FOR EACH ROW EXECUTE FUNCTION public\.(\w+)\(\);/g)) {
  const values = triggers.get(match[3]) ?? [];
  values.push(`${match[1]}: ${match[2].replace(/\s+/g, " ").trim()} -> \`${match[4]}()\``);
  triggers.set(match[3], values);
}

const identityColumns = new Set(
  [...sql.matchAll(/ALTER TABLE public\.(\w+) ALTER COLUMN (\w+) ADD GENERATED ALWAYS AS IDENTITY/g)]
    .map((match) => `${match[1]}.${match[2]}`)
);

function splitDefinitions(body) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let inQuote = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "'" && body[index - 1] !== "\\") inQuote = !inQuote;
    if (!inQuote && char === "(") depth += 1;
    if (!inQuote && char === ")") depth -= 1;
    if (!inQuote && char === "," && depth === 0) {
      parts.push(body.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(body.slice(start).trim());
  return parts;
}

function parseColumn(definition, tableName) {
  if (definition.startsWith("CONSTRAINT ")) return null;
  const firstSpace = definition.indexOf(" ");
  const name = definition.slice(0, firstSpace);
  const rest = definition.slice(firstSpace + 1);
  const marker = /\s+(?:DEFAULT|NOT NULL|GENERATED ALWAYS AS)\b/.exec(rest);
  const type = (marker ? rest.slice(0, marker.index) : rest).trim().replace(/^public\./, "");
  const nullable = !/\bNOT NULL\b/.test(rest);
  const defaultMatch = /\bDEFAULT ([\s\S]*?)(?=\s+NOT NULL|$)/.exec(rest);
  const generatedMatch = /\bGENERATED ALWAYS AS \(([\s\S]+)\) STORED/.exec(rest);
  let defaultValue = defaultMatch?.[1]?.replaceAll("::public.", "::").replaceAll("::bpchar", "") ?? "none";
  if (identityColumns.has(`${tableName}.${name}`)) defaultValue = "identity";
  if (generatedMatch) defaultValue = `generated: ${generatedMatch[1]}`;
  return { name, type, nullable, defaultValue };
}

function compactCheck(definition) {
  const match = /^CONSTRAINT (\S+) CHECK \(([\s\S]+)\)$/.exec(definition);
  if (!match) return null;
  return `\`${match[1]}\`: \`${match[2].replace(/\s+/g, " ")}\``;
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

const lines = [
  "# Database schema and table guide",
  "",
  `This document describes the PostgreSQL schema defined by [\`src/common/database/migrations/001_v6_final_baseline.sql\`](src/common/database/migrations/001_v6_final_baseline.sql). It is generated by [\`scripts/generate-database-schema-doc.mjs\`](scripts/generate-database-schema-doc.mjs).`,
  "",
  `The baseline contains **${tables.size} tables**, all in the **\`public\`** schema. Unless a foreign key says otherwise, all foreign keys use \`ON DELETE RESTRICT\`; deleting referenced business or evidence data is therefore prevented.`,
  "",
  "## How the data flows",
  "",
  "```text",
  "users --< workspace_members >-- workspaces",
  "  |                                  |",
  "  +-- sessions                      +-- scheduler_jobs",
  "                                     +-- analysis_runs --< analysis_run_items --< llm_runs",
  "entity hierarchy --> entity_paths ---------+                                  +--< prompt_jobs",
  "                                                                                   +--< provider_jobs",
  "                                                                                       +-- provider_results -- provider_scores",
  "                                                                                       +-- token_usage",
  "analysis_runs --< reports",
  "reliable side effects: notifications --> outbox_events; queue errors --> failure_records",
  "```",
  "",
  "## Table inventory",
  "",
  "| Area | Tables |",
  "|---|---|",
  ...Object.entries(group).map(([name, names]) => `| ${name} | ${names.map((table) => `[\`${table}\`](#${table.replaceAll("_", "-")})`).join(", ")} |`),
  "",
  "## Enum types",
  "",
  "| Enum | Allowed values |",
  "|---|---|",
  ...[...enums.entries()].map(([name, values]) => `| \`${name}\` | ${values.map((value) => `\`${value}\``).join(", ")} |`),
  "",
  "## Tables",
  "",
];

for (const [area, names] of Object.entries(group)) {
  lines.push(`### ${area}`, "");
  for (const tableName of names) {
    const body = tables.get(tableName);
    if (!body) throw new Error(`Missing table ${tableName}`);
    const definitions = splitDefinitions(body);
    const columns = definitions.map((definition) => parseColumn(definition, tableName)).filter(Boolean);
    const checks = definitions.map(compactCheck).filter(Boolean);
    const pkColumns = new Set((primaryKeys.get(tableName) ?? "").split(/,\s*/).filter(Boolean));
    const tableForeignKeys = foreignKeys.get(tableName) ?? [];
    const fkByColumn = new Map();
    for (const fk of tableForeignKeys) {
      const sourceColumns = fk.columns.split(/,\s*/);
      const targetColumns = fk.targetColumns.split(/,\s*/);
      sourceColumns.forEach((column, index) => {
        const existing = fkByColumn.get(column) ?? [];
        existing.push(`[\`${fk.targetTable}.${targetColumns[index]}\`](#${fk.targetTable.replaceAll("_", "-")})`);
        fkByColumn.set(column, existing);
      });
    }

    lines.push(
      `#### \`${tableName}\``,
      "",
      purpose[tableName] ?? "",
      "",
      `Primary key: \`${primaryKeys.get(tableName)}\`.`,
      "",
      "| Column | Type | Null? | Default / generation | Key or reference |",
      "|---|---|:---:|---|---|",
      ...columns.map((column) => {
        const key = [
          pkColumns.has(column.name) ? "PK" : "",
          ...(fkByColumn.get(column.name) ?? []),
        ].filter(Boolean).join("; ") || "none";
        return `| \`${column.name}\` | \`${escapeCell(column.type)}\` | ${column.nullable ? "yes" : "no"} | ${column.defaultValue === "none" ? "none" : `\`${escapeCell(column.defaultValue)}\``} | ${key} |`;
      }),
      "",
    );

    if ((uniqueConstraints.get(tableName) ?? []).length) {
      lines.push(`Unique keys: ${(uniqueConstraints.get(tableName) ?? []).map((value) => `\`${value}\``).join("; ")}.`, "");
    }
    if (tableForeignKeys.length) {
      lines.push(
        "Relationships:",
        "",
        ...tableForeignKeys.map((fk) => `- \`(${fk.columns})\` -> [\`${fk.targetTable}(${fk.targetColumns})\`](#${fk.targetTable.replaceAll("_", "-")}); delete behavior: \`${fk.onDelete}\`.`),
        "",
      );
    }
    if (checks.length) {
      lines.push("Important checks:", "", ...checks.map((check) => `- ${check}`), "");
    }
    if ((indexes.get(tableName) ?? []).length) {
      lines.push(
        "Indexes:",
        "",
        ...(indexes.get(tableName) ?? []).map((index) => `- \`${index.name}\`: ${index.unique ? "unique " : ""}\`${index.method}\` on \`(${index.expression})\`${index.predicate ? ` where \`${index.predicate}\`` : ""}.`),
        "",
      );
    }
    if ((triggers.get(tableName) ?? []).length) {
      lines.push("Triggers:", "", ...(triggers.get(tableName) ?? []).map((trigger) => `- ${trigger}.`), "");
    }
  }
}

const documented = new Set(Object.values(group).flat());
const missing = [...tables.keys()].filter((name) => !documented.has(name));
if (missing.length) throw new Error(`Undocumented tables: ${missing.join(", ")}`);

lines.push(
  "## Operational notes",
  "",
  "- Evidence tables (`analysis_run_provider_models`, `provider_results`, `provider_scores`, `token_usage`, and `reports`) reject updates and deletes through database triggers. New versions or revisions must be inserted instead.",
  "- `analysis_runs` preserves its anonymous origin. A claimed guest run may gain registered ownership only when it matches the immutable claim recorded on `anonymous_sessions`.",
  "- `provider_jobs` can only reference a `prompt_jobs` row whose `prompt_text` has already been rendered and is nonblank.",
  "- Inserts or state transitions can create notifications and outbox events for report readiness, budget pauses, cancellations, and terminal technical failures.",
  "- Monetary limits and usage are stored as integer millionths in `cost_limit_micros` and `cost_micros`, avoiding floating-point currency errors.",
  "",
  "## Regenerating this document",
  "",
  "After changing the baseline migration, run:",
  "",
  "```powershell",
  "node scripts/generate-database-schema-doc.mjs",
  "```",
  "",
  "The generator fails if a table exists in the migration but is missing from the curated inventory, preventing silent documentation gaps.",
  "",
);

await writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");
console.log(`Wrote ${outputPath} (${tables.size} tables, ${enums.size} enums).`);
