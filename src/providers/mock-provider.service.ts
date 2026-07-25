import type {
  DatabaseExecutor,
  TransactionPool
} from "../db/database-executor.js";
import { inTransaction } from "../db/database-executor.js";
import type { JsonObject } from "../types/database.types.js";
import { MockProviderRepository } from "./mock-provider.repository.js";
import type { ProviderJobCreatedPayload } from "./provider-worker.messages.js";

type MockProviderDatabase = DatabaseExecutor & TransactionPool;

export type MockProviderResult =
  | { outcome: "completed"; providerResultId: string }
  | { outcome: "noop"; providerResultId: null };

export class MockProviderExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "MockProviderExecutionError";
  }
}

export class MockProviderService {
  constructor(private readonly database: MockProviderDatabase) {}

  async execute(
    payload: ProviderJobCreatedPayload
  ): Promise<MockProviderResult> {
    return inTransaction(this.database, async (client) => {
      const repository = new MockProviderRepository(client);
      const state = await repository.findForUpdate(payload.providerJobId);
      if (!state) {
        throw new MockProviderExecutionError(
          "PROVIDER_JOB_NOT_FOUND",
          `Provider job ${payload.providerJobId} does not exist`
        );
      }
      if (state.status !== "queued") {
        return { outcome: "noop", providerResultId: null };
      }
      if (
        payload.promptJobId !== state.prompt_job_id ||
        payload.provider !== state.provider ||
        payload.model !== state.model
      ) {
        throw new MockProviderExecutionError(
          "PROVIDER_JOB_MESSAGE_MISMATCH",
          "Message identifiers or provider selection do not match authoritative state"
        );
      }
      if (state.provider !== "mock" || state.model !== "mock-fast") {
        throw new MockProviderExecutionError(
          "UNSUPPORTED_PROVIDER_SELECTION",
          "Phase 8 mock worker only executes mock/mock-fast jobs"
        );
      }
      if (
        state.prompt_status !== "processing" ||
        state.prompt_text === null ||
        !state.prompt_text.trim()
      ) {
        throw new MockProviderExecutionError(
          "PROMPT_NOT_RENDERED",
          "Mock provider requires a nonblank rendered prompt"
        );
      }

      const parsedResponse = deterministicEvidence(
        state.provider_job_id,
        state.prompt_type
      );
      const rawResponse = JSON.stringify(parsedResponse);
      const result = await repository.createOrReuseResult({
        providerJobId: state.provider_job_id,
        parsedResponse,
        rawResponse
      });
      await repository.createOrReuseActualUsage({
        providerJobId: state.provider_job_id,
        inputTokens: Math.max(1, Math.ceil(state.prompt_text.length / 4)),
        outputTokens: 32
      });
      if (
        !(await repository.markSucceeded(
          state.provider_job_id,
          state.prompt_job_id
        ))
      ) {
        throw new MockProviderExecutionError(
          "PROVIDER_JOB_TRANSITION_FAILED",
          "Provider and prompt jobs could not transition to succeeded"
        );
      }
      return {
        outcome: "completed",
        providerResultId: result.provider_result_id
      };
    });
  }
}

function deterministicEvidence(
  providerJobId: string,
  promptType: string
): JsonObject {
  return {
    provider: "mock",
    model: "mock-fast",
    promptType,
    evidence: [
      {
        claim: `Mock ${promptType} evidence for the selected entity path.`,
        source: "mock-provider",
        confidence: 0.75
      }
    ],
    summary: "Deterministic mock response for Phase 8 integration.",
    evidenceId: `mock-evidence:${providerJobId}`
  };
}
