import { apiError, apiResult } from "../../../utils/api-response.js";
import type { AnalysisRunItemStatus } from "../../../types/database.types.js";
import type {
  AnalysisRunItemWithPathRow,
  AnalysisRunItemsRepository
} from "../repositories/analysis-run-items.repository.js";
import type { AnalysisRunsRepository } from "../repositories/analysis-runs.repository.js";

const ITEM_STATUS_KEYS: AnalysisRunItemStatus[] = [
  "queued",
  "processing",
  "completed",
  "failed",
  "skipped",
  "cancelled"
];

export class AnalysisStatusService {
  constructor(
    private readonly analysisRunsRepository: AnalysisRunsRepository,
    private readonly analysisRunItemsRepository: AnalysisRunItemsRepository
  ) {}

  async getAnalysisRunStatus(analysisRunId: number) {
    const analysisRun = await this.analysisRunsRepository.getAnalysisRunWithItems(analysisRunId);

    if (!analysisRun) {
      return apiError(404, "Analysis run not found", { analysisRunId });
    }

    const items = await this.analysisRunItemsRepository.getRunItemsWithPaths(analysisRunId);

    return apiResult(200, {
      analysisRunId: analysisRun.analysis_run_id,
      domain: analysisRun.domain,
      requestPayload: analysisRun.request_payload,
      status: analysisRun.status,
      createdOn: analysisRun.created_on,
      updatedOn: analysisRun.updated_on,
      itemStatusSummary: this.summarizeItemStatuses(items),
      items: items.map((item) => this.mapRunItem(item))
    });
  }

  async getAnalysisRunDiffs(analysisRunId: number) {
    // TODO: V6_REBUILD_REQUIRED rebuild diffs around category/brand/product/use_context dimensions.
    return {
      statusCode: 501,
      body: {
        status: "not_implemented",
        code: "V6_ANALYSIS_DIFFS_REBUILD_REQUIRED",
        analysis_run_id: analysisRunId,
        message: "V6 analysis diffs are not implemented yet."
      }
    };
  }

  private summarizeItemStatuses(items: AnalysisRunItemWithPathRow[]): Record<AnalysisRunItemStatus, number> {
    const summary = ITEM_STATUS_KEYS.reduce(
      (counts, status) => ({
        ...counts,
        [status]: 0
      }),
      {} as Record<AnalysisRunItemStatus, number>
    );

    for (const item of items) {
      summary[item.run_item_status] += 1;
    }

    return summary;
  }

  private mapRunItem(item: AnalysisRunItemWithPathRow) {
    return {
      runItemId: item.run_item_id,
      status: item.run_item_status,
      pathId: item.path_id,
      pathType: item.path_type,
      domainId: item.domain_id,
      domain: item.domain,
      categoryId: item.category_id,
      category: item.category,
      brandId: item.brand_id,
      brandName: item.brand_name,
      productId: item.product_id,
      productName: item.product_name,
      contextId: item.context_id,
      context: item.context,
      createdOn: item.run_item_created_on,
      updatedOn: item.run_item_updated_on
    };
  }
}
