export type AnalysisRequest = {
  domain: string;
  categories?: AnalysisCategorySelection[];
};

export type AnalysisCategorySelection = {
  categoryId: number;
  brands?: AnalysisBrandSelection[];
};

export type AnalysisBrandSelection = {
  brandId: number;
  products?: AnalysisProductSelection[];
};

export type AnalysisProductSelection = {
  productId: number;
  useContextIds?: number[];
};

