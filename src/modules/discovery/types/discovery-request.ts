export type DiscoveryRequest =
  | {
      kind: "domain";
      requestedValue: string;
      contextCategoryId?: number;
      notes?: string;
    }
  | {
      kind: "brand";
      requestedValue: string;
      contextDomain: string;
      contextCategoryId?: number;
      notes?: string;
    }
  | {
      kind: "product";
      requestedValue: string;
      contextDomain: string;
      contextCategoryId?: number;
      contextBrandId?: number;
      notes?: string;
    };
