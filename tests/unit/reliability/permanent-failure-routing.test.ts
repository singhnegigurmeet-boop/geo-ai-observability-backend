import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  resolvePermanentFailureRoute,
  UnsupportedPermanentFailureRouteError
} from "../../../src/modules/reliability/services/permanent-failure-routing.service.js";

describe("permanent failure aggregate/queue routing", () => {
  it("routes normal provider-result scoring separately", () => {
    assert.equal(
      resolvePermanentFailureRoute("provider_result", "scoring_queue"),
      "normal_scoring"
    );
  });

  it("routes pre-analysis discovery separately", () => {
    assert.equal(
      resolvePermanentFailureRoute(
        "pre_analysis_request",
        "domain_hierarchy_discovery_queue"
      ),
      "pre_analysis_request"
    );
  });

  it("does not route a normal scoring result through discovery", () => {
    assert.notEqual(
      resolvePermanentFailureRoute("provider_result", "scoring_queue"),
      "pre_analysis_request"
    );
  });

  it("rejects unsupported aggregate and queue combinations explicitly", () => {
    assert.throws(
      () =>
        resolvePermanentFailureRoute(
          "provider_result",
          "analysis_run_queue"
        ),
      UnsupportedPermanentFailureRouteError
    );
  });

  it("routes every retrying business aggregate to its established stage", () => {
    assert.deepEqual(
      [
        ["analysis_run", "analysis_run_queue"],
        ["analysis_run_item", "analysis_run_item_queue"],
        ["llm_run", "llm_run_queue"],
        ["prompt_job", "visibility_prompt_queue"],
        ["provider_job", "mock_queue"],
        ["scheduler_job", "scheduler_queue"],
        ["notification", "notification_queue"]
      ].map(([aggregateType, queueName]) =>
        resolvePermanentFailureRoute(aggregateType!, queueName!)
      ),
      [
        "analysis_run",
        "analysis_run_item",
        "llm_run",
        "prompt_job",
        "provider_job",
        "scheduler_job",
        "notification"
      ]
    );
  });
});
