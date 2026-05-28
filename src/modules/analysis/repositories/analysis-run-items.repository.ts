import { SQL_QUERIES } from "../../../db/sql-queries.js";
import { BaseRepository } from "../../../repositories/base.repository.js";
import type {
  AnalysisRunItemRow,
  AnalysisRunItemsInput,
  AnalysisRunItemStatus
} from "../../../types/database.types.js";

export type AnalysisRunItemWithPathRow = {
  run_item_id: number;
  analysis_run_id: number;
  path_id: number;
  run_item_status: AnalysisRunItemStatus;
  run_item_created_on: Date;
  run_item_updated_on: Date;
  run_item_is_active: boolean;
  domain_id: number;
  category_id: number;
  brand_id: number | null;
  product_id: number | null;
  context_id: number | null;
  path_type: "category" | "brand" | "product_context";
  path_created_on: Date;
  path_updated_on: Date;
  path_is_active: boolean;
  domain: string;
  category: string;
  brand_name: string | null;
  product_name: string | null;
  context: string | null;
};

export class AnalysisRunItemsRepository extends BaseRepository<AnalysisRunItemRow> {
  async createAnalysisRunItems(input: AnalysisRunItemsInput): Promise<AnalysisRunItemRow[]> {
    if (input.pathIds.length === 0) {
      return [];
    }

    return this.executeQuery<AnalysisRunItemRow>(SQL_QUERIES.analysisRunItems.createMany, [
      input.analysisRunId,
      input.pathIds
    ]);
  }

  async listRunItems(analysisRunId: number): Promise<AnalysisRunItemRow[]> {
    return this.executeQuery<AnalysisRunItemRow>(SQL_QUERIES.analysisRunItems.listByRunId, [analysisRunId]);
  }

  async updateRunItemStatus(
    runItemId: number,
    status: AnalysisRunItemStatus
  ): Promise<AnalysisRunItemRow | null> {
    return this.executeSingleQuery<AnalysisRunItemRow>(SQL_QUERIES.analysisRunItems.updateStatus, [
      runItemId,
      status
    ]);
  }

  async getRunItemsWithPaths(analysisRunId: number): Promise<AnalysisRunItemWithPathRow[]> {
    return this.executeQuery<AnalysisRunItemWithPathRow>(SQL_QUERIES.analysisRunItems.getWithPaths, [
      analysisRunId
    ]);
  }
}

export const analysisRunItemsRepository = new AnalysisRunItemsRepository();
