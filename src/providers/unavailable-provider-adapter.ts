import { ProviderName } from "../config/constants.js";
import { ProviderAdapter } from "../types/provider.types.js";

export class UnavailableProviderAdapter implements ProviderAdapter {
  constructor(
    readonly name: ProviderName,
    private readonly reason: string
  ) {}

  async runTextPrompt(): Promise<string> {
    throw new Error(this.reason);
  }
}
