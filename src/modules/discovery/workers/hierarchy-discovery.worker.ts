import { parseHierarchyDiscoveryMessage } from "../messages/hierarchy-discovery.messages.js";
import type { HierarchyDiscoveryService } from "../services/hierarchy-discovery.service.js";

export class HierarchyDiscoveryWorker {
  constructor(private readonly discovery: Pick<HierarchyDiscoveryService,"progress">) {}
  process(input: unknown) { return this.discovery.progress(parseHierarchyDiscoveryMessage(input).payload); }
}
