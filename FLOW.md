# GEO V6 Production Runtime Flow

This is the canonical runtime and business-flow guide for GEO V6. PostgreSQL is
the business-state authority. RabbitMQ carries ID-only work messages. The
transactional outbox is the only database-to-broker handoff.

For exact service and message signatures plus table mutations, see
[BUSINESS_LOGIC_AND_DATA_FLOW.md](BUSINESS_LOGIC_AND_DATA_FLOW.md). For every
table, column, key, constraint, index, and trigger, see
[DATABASE_SCHEMA.md](DATABASE_SCHEMA.md).

## 1. Request policy

`POST /v1/analysis` accepts:

- a strict public hostname, never a URL, path, port, credential, IP address, or
  internal hostname;
- an optional contiguous hierarchy path:
  `category -> brand -> product -> useContext`;
- `categorySelection: { mode: "all" }` or
  `{ mode: "selected", categoryIds: [...] }`;
- `promptDepth: weak | medium | high`;
- exact provider/model pairs or vendor-wide `{ provider, selection: "all" }`.

Anonymous requests are fixed to weak depth and `mock/mock-fast`; they cannot
submit provider choices. Logged-in and claimed requests must explicitly choose
depth and may select only enabled registry models. The registry freezes model
profile version, queue, structured-output mode, instruction profile, token
ceilings, supported depths, and pricing.

Creation resolves `all` to exact active category IDs and vendor-wide `all` to
exact enabled models. Both sets are immutable for the life of the run.

`POST /v1/analysis/preview` applies the same normalization and policy but does
not create business rows. It reports classification need, selected-path and
prompt estimates, exact model count, provider-job count, token estimate, and a
cost range.

## 2. Canonical creation and idempotency

The canonical request contains the normalized hostname, hierarchy IDs, exact
category IDs, category-selection mode, prompt depth, prompt-policy version, and
exact provider/model pairs. The client idempotency key is namespaced by the
resolved anonymous session or user/workspace.

- Same owner, key, and canonical request: replay the existing run.
- Same owner and key with different canonical input: conflict.
- Different owners: independent namespaces.

One transaction inserts:

```text
analysis_runs
  +-- analysis_run_requested_categories
  +-- analysis_run_provider_models
  +-- outbox_events: analysis_run.created
```

## 3. Domain classification and expansion

Expansion reloads the run and validated starting path.

For a domain target:

1. Reuse active `domain_categories` links that match the frozen candidate set.
2. If candidates remain unresolved, create one
   `domain_category_classification_jobs` aggregate with the normalized domain,
   exact candidate IDs/names, classifier model profile, prompt version,
   response contract, instruction profile, and structured-output mode.
3. Render and execute exactly one configured classifier.
4. Validate its result against the frozen candidate IDs and current active
   category rows.
5. Insert only accepted links into `domain_categories`, with provider-result
   provenance, rank, confidence, and classification timestamp.
6. Requeue the original run and expand in accepted-rank order.

Classification never invents a category and never accepts an ID outside the
frozen set. Existing active manual/import links are reused. Anonymous breadth is
three; user/claimed breadth is five.

For a non-domain target, expansion selects exactly one hierarchy level:

| Starting target | Analysis item targets |
|---|---|
| category | active brands |
| brand | active products |
| product | active use contexts |
| use context | that exact leaf |

No eligible child produces an immutable `completed_empty` report. A completed
classifier with zero accepted matches records reason `no_matching_category`;
other empty expansions record `no_applicable_analysis_item`. Both are valid
business outcomes, not technical failures.

## 4. Normal execution pipeline

```text
analysis_run.created { analysisRunId }
  -> analysis_run_items

analysis_run_item.created { analysisRunItemId }
  -> llm_runs

llm_run.created { llmRunId }
  -> prompt_jobs

prompt_job.created { promptJobId }
  -> rendered prompt
  -> provider_jobs, one per frozen provider/model

provider_job.created { providerJobId }
  -> estimated token_usage reservation
  -> provider call
  -> immutable provider_results
  -> actual token_usage

provider_result.created { providerResultId }  # visibility/ranking only
  -> provider_scores
  -> immutable report revision
```

Every queue message contains only its aggregate ID. Consumers reload the
business state and no correctness rule depends on broker ordering.

## 5. Prompt business logic

Prompt applicability is target-based, not actor-based:

| Target | Prompt types |
|---|---|
| domain | none; classification must resolve category targets first |
| category | visibility, ranking, competitor |
| brand/product/use context | visibility, ranking, competitor, price range, pros/cons |

Each `prompt_jobs` row freezes:

- prompt type and depth;
- business prompt version;
- response-contract version;
- the authoritative entity-path snapshot.

The renderer names the exact website, canonical hierarchy, starting level,
target level, exact target, comparison scope, and depth. It requires JSON only,
forbids invented browsing/citations/prices/rankings, requires explicit
uncertainty, and bounds evidence, arrays, summary size, and ranking top-K.

Before fan-out, the service recomputes the authoritative DB path and rejects a
changed snapshot. Each `provider_jobs` row then freezes the rendered request
payload/hash and model execution identity.

## 6. Provider output and evidence

Adapters return generated content plus sanitized provider metadata; they do not
decide business validity. The application validates four layers:

1. JSON parsing;
2. strict prompt-specific runtime contract;
3. semantic bounds and invariants;
4. frozen database/context identity.

Ranking additionally verifies top-K, contiguous candidate ranks, and that the
reported target position contains the exact target. Classification verifies
every category ID against both the candidate list and the active frozen set.

Valid and invalid responses are immutable evidence. Invalid generated output is
terminal evidence, not a retryable transport error, and is never scored. Raw
generated content is retained as a valid UTF-8 prefix capped at 256 KiB, with
truncation and original byte length recorded. Public reports never expose raw
content.

## 7. Budget and concurrency logic

Before a provider call, the worker obtains a run-level transaction lock, then
locks the provider job and applicable budget policies in deterministic order.
The conservative reservation uses prompt input tokens plus the model/depth
output ceiling.

Applicable policies may cover platform, workspace, user, anonymous session,
analysis run, provider, or exact model:

- hard limit: block before the projected crossing;
- soft limit: allow one crossing request, then block later work;
- block: mark work and the run `paused_budget`, create a partial snapshot, and
  acknowledge without retry, failure record, or DLQ.

Estimated and actual usage remain separate immutable ledger rows. Accounting
prefers actual usage when present, otherwise the estimate.

## 8. Scoring and aggregation

Only visibility and ranking are GEO score metrics. Competitor, price-range, and
pros/cons results are diagnostic evidence.

```text
visibility =
  100 * (
    0.45 * mention_likelihood
    + 0.35 * recommendation_likelihood
    + 0.20 * competitive_prominence
  )

ranking, found =
  100 * (top_k - rank_position + 1) / top_k

ranking, valid not-found evidence = 0
```

Confidence is reported separately and never inflates the score.

Report version `multi-provider-geo-v3` aggregates in this order:

1. visibility/ranking scores for each entity-path + provider/model;
2. model-path GEO score, weighted 60/40 and renormalized if one metric is
   missing;
3. equal model weight within a category;
4. equal category weight for the overall run.

Expected coverage is derived from analysis items × applicable prompt policy ×
frozen models, not merely from already materialized provider jobs. Missing,
invalid, failed, cancelled, budget-paused, and scoring-failure outcomes remain
visible gaps and are not silently converted to zero.

Classification evidence and cost are included separately in the report.
The report also materializes methodology, executive and overall dimensions,
category and provider/model comparisons, visibility, ranking, competitor,
price, pros/cons, coverage, and category/classification usage sections from
validated evidence only.

## 9. Lifecycle, retries, cancellation, and scheduling

Technical queue failures receive three total attempts. Attempts one and two are
recorded and republished with a worker-attempt header; attempt three is recorded
and rejected to the queue DLQ. Terminalization derives parent lifecycle and
creates a final gap-aware report without discarding successful sibling
evidence.

Cancellation is allowed only before provider execution starts. It cancels
unstarted classification, prompt, provider, LLM, and analysis-item work,
terminalizes the run, and creates the appropriate cancelled report. Delayed
messages reload state and no-op.

Scheduler rows freeze the same category set, depth, prompt-policy version, and
model selection as manual requests. Each due tick revalidates owner membership,
hierarchy, categories, policy version, models, timezone, and interval. A valid
tick creates a scheduled run with identity:

```text
scheduled_analysis:<schedulerJobId>:<dueAt>
```

Permanent invalidity pauses the schedule and records an admin notification.
Transient infrastructure errors are rethrown so the schedule remains
retryable.

## 10. Security and observability boundaries

- Session tokens are hashed; raw tokens are never stored.
- Ownership is derived from the exact anonymous origin or current
  user/workspace membership.
- Queue bodies and outbox events carry IDs, not prompt or provider content.
- Provider metadata is sanitized before persistence.
- Public error messages expose stable categories, not internal diagnostics.
- `/health` is process liveness; `/ready` verifies PostgreSQL, the exact
  migration ledger, RabbitMQ, and every queue/DLQ including classification.
- Notifications, failure records, outbox events, usage, evidence, scores, and
  reports provide durable operational history.
