export class AnalysisStatusService {
  async getAnalysisRunStatus(analysisRunId: number) {
    // TODO: V6_REBUILD_REQUIRED read V6 analysis run state once the PostgreSQL model is rebuilt.
    return {
      statusCode: 501,
      body: {
        status: "not_implemented",
        code: "V6_ANALYSIS_STATUS_REBUILD_REQUIRED",
        analysis_run_id: analysisRunId,
        message: "V6 analysis run status is not implemented yet."
      }
    };
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
}

