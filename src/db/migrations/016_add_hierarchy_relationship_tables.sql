CREATE TABLE domain_categories (
  domain_category_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain_id bigint NOT NULL REFERENCES domains(domain_id) ON DELETE RESTRICT,
  category_id bigint NOT NULL REFERENCES categories(category_id) ON DELETE RESTRICT,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer,
  source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT domain_categories_domain_category_unique UNIQUE (
    domain_id,
    category_id
  )
);

CREATE INDEX domain_categories_selection_idx
  ON domain_categories (
    domain_id,
    is_active,
    sort_order ASC NULLS LAST,
    created_at,
    domain_category_id
  );

CREATE INDEX domain_categories_category_idx
  ON domain_categories (category_id);

CREATE TABLE category_brands (
  category_brand_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain_category_id bigint NOT NULL
    REFERENCES domain_categories(domain_category_id) ON DELETE RESTRICT,
  brand_id bigint NOT NULL REFERENCES brands(brand_id) ON DELETE RESTRICT,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer,
  source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT category_brands_domain_category_brand_unique UNIQUE (
    domain_category_id,
    brand_id
  )
);

CREATE INDEX category_brands_selection_idx
  ON category_brands (
    domain_category_id,
    is_active,
    sort_order ASC NULLS LAST,
    created_at,
    category_brand_id
  );

CREATE INDEX category_brands_brand_idx
  ON category_brands (brand_id);

CREATE TABLE brand_products (
  brand_product_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category_brand_id bigint NOT NULL
    REFERENCES category_brands(category_brand_id) ON DELETE RESTRICT,
  product_id bigint NOT NULL REFERENCES products(product_id) ON DELETE RESTRICT,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer,
  source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brand_products_category_brand_product_unique UNIQUE (
    category_brand_id,
    product_id
  )
);

CREATE INDEX brand_products_selection_idx
  ON brand_products (
    category_brand_id,
    is_active,
    sort_order ASC NULLS LAST,
    created_at,
    brand_product_id
  );

CREATE INDEX brand_products_product_idx
  ON brand_products (product_id);

CREATE TABLE product_use_contexts (
  product_use_context_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  brand_product_id bigint NOT NULL
    REFERENCES brand_products(brand_product_id) ON DELETE RESTRICT,
  use_context_id bigint NOT NULL
    REFERENCES use_contexts(use_context_id) ON DELETE RESTRICT,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer,
  source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_use_contexts_brand_product_context_unique UNIQUE (
    brand_product_id,
    use_context_id
  )
);

CREATE INDEX product_use_contexts_selection_idx
  ON product_use_contexts (
    brand_product_id,
    is_active,
    sort_order ASC NULLS LAST,
    created_at,
    product_use_context_id
  );

CREATE INDEX product_use_contexts_use_context_idx
  ON product_use_contexts (use_context_id);
