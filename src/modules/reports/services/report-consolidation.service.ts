import type { JsonObject } from "../../../common/types/database.types.js";
import type { ReportExecutionRecord } from "../repositories/report.repository.js";

const MAX_CONSOLIDATED_ITEMS = 50;

export function consolidateDiagnostics(records: readonly ReportExecutionRecord[]) {
  const valid = records.filter(
    (record) =>
      record.result_status === "valid" &&
      record.context_validation_status === "valid" &&
      responseResult(record.validated_response) !== null
  );
  return {
    visibility: group(valid.filter((record) => record.prompt_type === "visibility"))
      .map(consolidateVisibility),
    ranking: group(valid.filter((record) => record.prompt_type === "ranking"))
      .map(consolidateRanking),
    competitors: group(valid.filter((record) => record.prompt_type === "competitor"))
      .map(consolidateCompetitors),
    price: group(valid.filter((record) => record.prompt_type === "price_range"))
      .map(consolidatePrice),
    prosAndCons: group(valid.filter((record) => record.prompt_type === "pros_cons"))
      .map(consolidateProsAndCons)
  };
}

function consolidateVisibility(records: ReportExecutionRecord[]): JsonObject {
  const rows = records.map((record) => {
    const result = responseResult(record.validated_response)!;
    return {
      provider: record.provider,
      model: record.model,
      mentionLikelihood: number(result.mention_likelihood),
      recommendationLikelihood: number(result.recommendation_likelihood),
      competitiveProminence: number(result.competitive_prominence),
      confidence: number(result.confidence)
    };
  });
  const dimensions = {
    mentionLikelihood: statistics(rows.flatMap((row) =>
      row.mentionLikelihood === null ? [] : [row.mentionLikelihood])),
    recommendationLikelihood: statistics(rows.flatMap((row) =>
      row.recommendationLikelihood === null ? [] : [row.recommendationLikelihood])),
    competitiveProminence: statistics(rows.flatMap((row) =>
      row.competitiveProminence === null ? [] : [row.competitiveProminence])),
    confidence: statistics(rows.flatMap((row) =>
      row.confidence === null ? [] : [row.confidence]))
  };
  return {
    ...identity(records[0]!),
    byProviderModel: rows,
    ...dimensions,
    queryIntents: frequencies(records, "query_intents"),
    strengths: frequencies(records, "strengths"),
    visibilityGaps: frequencies(records, "visibility_gaps"),
    disagreement: {
      mentionLikelihoodRange: dimensions.mentionLikelihood.range,
      recommendationLikelihoodRange:
        dimensions.recommendationLikelihood.range,
      competitiveProminenceRange: dimensions.competitiveProminence.range
    }
  };
}

function consolidateRanking(records: ReportExecutionRecord[]): JsonObject {
  const rows = records.map((record) => {
    const result = responseResult(record.validated_response)!;
    return {
      provider: record.provider,
      model: record.model,
      requestedTopK: number(result.requested_top_k),
      found: result.found === true,
      rankPosition: number(result.rank_position),
      orderedCandidates: Array.isArray(result.ordered_candidates)
        ? result.ordered_candidates.slice(0, MAX_CONSOLIDATED_ITEMS)
        : []
    };
  });
  const ranks = rows.flatMap((row) =>
    row.found && row.rankPosition !== null ? [row.rankPosition] : []
  );
  const candidateKeys = rows.map((row) =>
    JSON.stringify(row.orderedCandidates)
  );
  return {
    ...identity(records[0]!),
    requestedTopK: sortedUnique(
      rows.flatMap((row) => row.requestedTopK === null ? [] : [row.requestedTopK])
    ),
    byProviderModel: rows,
    foundCount: rows.filter((row) => row.found).length,
    notFoundCount: rows.filter((row) => !row.found).length,
    foundRate: ratio(rows.filter((row) => row.found).length, rows.length),
    rank: statistics(ranks),
    candidateListDisagreement: {
      distinctCandidateLists: new Set(candidateKeys).size,
      providerModelCount: rows.length,
      disagrees: new Set(candidateKeys).size > 1
    }
  };
}

function consolidateCompetitors(records: ReportExecutionRecord[]): JsonObject {
  const direct = competitorFrequencies(records, "direct_competitors");
  const indirect = competitorFrequencies(records, "indirect_competitors");
  const directKeys = new Set(direct.items.map((item) => item.normalizedKey));
  const contradictions = indirect.items
    .filter((item) => directKeys.has(item.normalizedKey))
    .map((item) => item.displayName);
  const pressure = records.flatMap((record) => {
    const value = number(responseResult(record.validated_response)!.competitive_pressure);
    return value === null ? [] : [value];
  });
  return {
    ...identity(records[0]!),
    directCompetitors: direct,
    indirectCompetitors: indirect,
    directIndirectContradictions: bounded(contradictions.sort()),
    competitivePressure: statistics(pressure),
    targetDifferentiation: textFrequencies(records, "target_differentiation")
  };
}

function consolidatePrice(records: ReportExecutionRecord[]): JsonObject {
  const rows = records.map((record) => {
    const result = responseResult(record.validated_response)!;
    return {
      provider: record.provider,
      model: record.model,
      applicability:
        result.applicability === "applicable" ||
        result.applicability === "not_applicable"
          ? result.applicability
          : "unknown",
      currency: typeof result.currency === "string" ? result.currency : null,
      minimum: number(result.minimum),
      maximum: number(result.maximum),
      pricingBasis:
        typeof result.pricing_basis === "string" ? result.pricing_basis : "",
      uncertainty:
        typeof result.uncertainty === "string" ? result.uncertainty : ""
    };
  });
  const currencies = sortedUnique(
    rows.flatMap((row) => row.currency === null ? [] : [row.currency])
  );
  const rangesByCurrency = currencies.map((currency) => {
    const same = rows.filter(
      (row) => row.currency === currency && row.applicability === "applicable"
    );
    return {
      currency,
      minimum: statistics(same.flatMap((row) =>
        row.minimum === null ? [] : [row.minimum])),
      maximum: statistics(same.flatMap((row) =>
        row.maximum === null ? [] : [row.maximum]))
    };
  });
  const applicability = {
    applicable: rows.filter((row) => row.applicability === "applicable").length,
    notApplicable:
      rows.filter((row) => row.applicability === "not_applicable").length,
    unknown: rows.filter((row) => row.applicability === "unknown").length
  };
  return {
    ...identity(records[0]!),
    byProviderModel: rows,
    applicability,
    currenciesObserved: currencies,
    rangesByCurrency,
    incompatibleCurrencyWarning: currencies.length > 1,
    applicabilityContradiction:
      Object.values(applicability).filter((count) => count > 0).length > 1,
    pricingBasis: textFrequencies(records, "pricing_basis"),
    uncertainty: textFrequencies(records, "uncertainty")
  };
}

function consolidateProsAndCons(records: ReportExecutionRecord[]): JsonObject {
  const pros = frequencies(records, "pros");
  const cons = frequencies(records, "cons");
  const proKeys = new Set(pros.items.map((item) => item.normalizedKey));
  const contradictions = cons.items
    .filter((item) => proKeys.has(item.normalizedKey))
    .map((item) => item.displayText);
  return {
    ...identity(records[0]!),
    commonStrengths: withFrequencyThreshold(pros, 2),
    commonWeaknesses: withFrequencyThreshold(cons, 2),
    uncommonStrengths: withFrequencyThreshold(pros, 1, true),
    uncommonWeaknesses: withFrequencyThreshold(cons, 1, true),
    contradictions: bounded(contradictions.sort()),
    bestFitContexts: frequencies(records, "best_fit_for"),
    poorFitContexts: frequencies(records, "poor_fit_for"),
    comparisonContexts: textFrequencies(records, "comparison_context")
  };
}

function group(records: ReportExecutionRecord[]) {
  const groups = new Map<string, ReportExecutionRecord[]>();
  for (const record of records) {
    const key = `${record.entity_path_id}\u0000${record.category_id ?? ""}`;
    const values = groups.get(key) ?? [];
    values.push(record);
    groups.set(key, values);
  }
  return [...groups.values()].sort((left, right) =>
    identityKey(left[0]!).localeCompare(identityKey(right[0]!))
  );
}

function identity(record: ReportExecutionRecord) {
  return {
    categoryId: record.category_id,
    categoryName: record.category_name,
    entityPathId: record.entity_path_id
  };
}

function identityKey(record: ReportExecutionRecord) {
  return `${record.category_name ?? ""}\u0000${record.category_id ?? ""}\u0000${record.entity_path_id}`;
}

function statistics(values: number[]) {
  if (values.length === 0) {
    return { count: 0, average: null, median: null, minimum: null, maximum: null, range: null, standardDeviation: null };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const average = mean(sorted);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2
    ? sorted[middle]!
    : mean([sorted[middle - 1]!, sorted[middle]!]);
  const variance = mean(sorted.map((value) => (value - average) ** 2));
  return {
    count: sorted.length,
    average,
    median,
    minimum: sorted[0]!,
    maximum: sorted.at(-1)!,
    range: round(sorted.at(-1)! - sorted[0]!),
    standardDeviation: sorted.length < 2 ? null : round(Math.sqrt(variance))
  };
}

function frequencies(records: ReportExecutionRecord[], field: string) {
  const values = records.flatMap((record) => {
    const result = responseResult(record.validated_response)!;
    return Array.isArray(result[field])
      ? result[field].filter((value): value is string => typeof value === "string")
      : [];
  });
  return frequencyRows(values);
}

function textFrequencies(records: ReportExecutionRecord[], field: string) {
  return frequencyRows(records.flatMap((record) => {
    const value = responseResult(record.validated_response)![field];
    return typeof value === "string" && value.trim() ? [value] : [];
  }));
}

function frequencyRows(values: string[]) {
  const rows = new Map<string, { normalizedKey: string; displayText: string; count: number }>();
  for (const value of values) {
    const key = normalizeText(value);
    if (!key) continue;
    const current = rows.get(key);
    if (current) current.count += 1;
    else rows.set(key, { normalizedKey: key, displayText: value.trim(), count: 1 });
  }
  const all = [...rows.values()].sort(
    (left, right) =>
      right.count - left.count ||
      left.normalizedKey.localeCompare(right.normalizedKey)
  );
  return boundedObjects(all);
}

function competitorFrequencies(
  records: ReportExecutionRecord[],
  field: "direct_competitors" | "indirect_competitors"
) {
  const rows = new Map<string, {
    normalizedKey: string;
    displayName: string;
    frequency: number;
    relevanceRanks: number[];
    overlapReasons: string[];
  }>();
  for (const record of records) {
    const result = responseResult(record.validated_response)!;
    const competitors = Array.isArray(result[field]) ? result[field] : [];
    for (const candidate of competitors) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
      const key = normalizeText(name);
      if (!key) continue;
      const row = rows.get(key) ?? {
        normalizedKey: key,
        displayName: name,
        frequency: 0,
        relevanceRanks: [],
        overlapReasons: []
      };
      row.frequency += 1;
      if (typeof candidate.relevance_rank === "number") {
        row.relevanceRanks.push(candidate.relevance_rank);
      }
      if (typeof candidate.reason_for_overlap === "string") {
        row.overlapReasons.push(candidate.reason_for_overlap.trim());
      }
      rows.set(key, row);
    }
  }
  return boundedObjects([...rows.values()]
    .map((row) => ({
      normalizedKey: row.normalizedKey,
      displayName: row.displayName,
      frequency: row.frequency,
      averageRelevanceRank:
        row.relevanceRanks.length ? mean(row.relevanceRanks) : null,
      overlapReasons: sortedUnique(row.overlapReasons)
    }))
    .sort((left, right) =>
      right.frequency - left.frequency ||
      (left.averageRelevanceRank ?? Number.MAX_SAFE_INTEGER) -
        (right.averageRelevanceRank ?? Number.MAX_SAFE_INTEGER) ||
      left.normalizedKey.localeCompare(right.normalizedKey)
    ));
}

function withFrequencyThreshold(
  source: ReturnType<typeof frequencyRows>,
  threshold: number,
  exact = false
) {
  const items = source.items.filter((item) =>
    exact ? item.count === threshold : item.count >= threshold
  );
  return {
    totalCount: items.length,
    returnedCount: items.length,
    truncated: false,
    items
  };
}

function bounded(values: string[]) {
  const items = values.slice(0, MAX_CONSOLIDATED_ITEMS);
  return {
    totalCount: values.length,
    returnedCount: items.length,
    truncated: items.length < values.length,
    items
  };
}

function boundedObjects<T extends JsonObject>(values: T[]) {
  const items = values.slice(0, MAX_CONSOLIDATED_ITEMS);
  return {
    totalCount: values.length,
    returnedCount: items.length,
    truncated: items.length < values.length,
    items
  };
}

function responseResult(response: JsonObject | null): JsonObject | null {
  const result = response?.result;
  return result && typeof result === "object" && !Array.isArray(result)
    ? result
    : null;
}

function normalizeText(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
}

function sortedUnique<T extends string | number>(values: T[]) {
  return [...new Set(values)].sort((left, right) =>
    typeof left === "number" && typeof right === "number"
      ? left - right
      : String(left).localeCompare(String(right))
  );
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function ratio(numerator: number, denominator: number) {
  return denominator === 0 ? null : round(numerator / denominator);
}

function mean(values: number[]) {
  return round(values.reduce((total, value) => total + value, 0) / values.length);
}

function round(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
