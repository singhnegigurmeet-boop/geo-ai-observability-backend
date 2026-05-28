export type DiscoveryRequest =
  | {
      kind: "domain";
      domain: string;
      categoryId?: number;
      notes?: string;
    }
  | {
      kind: "brand";
      domain: string;
      brandName: string;
      categoryId?: number;
      notes?: string;
    }
  | {
      kind: "product";
      domain: string;
      brandId?: number;
      productName: string;
      categoryId?: number;
      notes?: string;
    };

