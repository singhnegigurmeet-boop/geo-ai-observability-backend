import type { ProviderName } from "../types/database.types.js";

export type ProviderModelSelection = {
  provider: ProviderName;
  model: string;
  queueName: "mock_queue";
};

const PHASE8_MOCK_SELECTION = {
  provider: "mock",
  model: "mock-fast",
  queueName: "mock_queue"
} as const satisfies ProviderModelSelection;

export function selectProviderModel(): ProviderModelSelection {
  return PHASE8_MOCK_SELECTION;
}
