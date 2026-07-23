CREATE TABLE domains (
  domain_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  normalized_domain text NOT NULL UNIQUE,
  display_domain text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT domains_normalized_not_blank_check CHECK (
    length(normalized_domain) BETWEEN 1 AND 253
  ),
  CONSTRAINT domains_normalized_format_check CHECK (
    normalized_domain = lower(btrim(normalized_domain))
    AND normalized_domain !~ '[[:space:]/:]'
    AND normalized_domain ~ '^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$'
  )
);

CREATE TABLE categories (
  category_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category_name text NOT NULL,
  normalized_name text NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT categories_name_not_blank_check CHECK (length(btrim(category_name)) > 0),
  CONSTRAINT categories_normalized_check CHECK (
    length(btrim(normalized_name)) > 0
    AND normalized_name = lower(btrim(normalized_name))
  )
);

CREATE TABLE brands (
  brand_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  brand_name text NOT NULL,
  normalized_name text NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brands_name_not_blank_check CHECK (length(btrim(brand_name)) > 0),
  CONSTRAINT brands_normalized_check CHECK (
    length(btrim(normalized_name)) > 0
    AND normalized_name = lower(btrim(normalized_name))
  )
);

CREATE TABLE products (
  product_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_name text NOT NULL,
  normalized_name text NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT products_name_not_blank_check CHECK (length(btrim(product_name)) > 0),
  CONSTRAINT products_normalized_check CHECK (
    length(btrim(normalized_name)) > 0
    AND normalized_name = lower(btrim(normalized_name))
  )
);

CREATE TABLE use_contexts (
  use_context_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  use_context_name text NOT NULL,
  normalized_name text NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT use_contexts_name_not_blank_check CHECK (
    length(btrim(use_context_name)) > 0
  ),
  CONSTRAINT use_contexts_normalized_check CHECK (
    length(btrim(normalized_name)) > 0
    AND normalized_name = lower(btrim(normalized_name))
  )
);

CREATE TABLE entity_paths (
  entity_path_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain_id bigint NOT NULL REFERENCES domains(domain_id) ON DELETE RESTRICT,
  category_id bigint REFERENCES categories(category_id) ON DELETE RESTRICT,
  brand_id bigint REFERENCES brands(brand_id) ON DELETE RESTRICT,
  product_id bigint REFERENCES products(product_id) ON DELETE RESTRICT,
  use_context_id bigint REFERENCES use_contexts(use_context_id) ON DELETE RESTRICT,
  path_type entity_path_type NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entity_paths_shape_check CHECK (
    (
      path_type = 'domain'
      AND category_id IS NULL
      AND brand_id IS NULL
      AND product_id IS NULL
      AND use_context_id IS NULL
    )
    OR
    (
      path_type = 'category'
      AND category_id IS NOT NULL
      AND brand_id IS NULL
      AND product_id IS NULL
      AND use_context_id IS NULL
    )
    OR
    (
      path_type = 'brand'
      AND category_id IS NOT NULL
      AND brand_id IS NOT NULL
      AND product_id IS NULL
      AND use_context_id IS NULL
    )
    OR
    (
      path_type = 'product'
      AND category_id IS NOT NULL
      AND brand_id IS NOT NULL
      AND product_id IS NOT NULL
      AND use_context_id IS NULL
    )
    OR
    (
      path_type = 'use_context'
      AND category_id IS NOT NULL
      AND brand_id IS NOT NULL
      AND product_id IS NOT NULL
      AND use_context_id IS NOT NULL
    )
  ),
  CONSTRAINT entity_paths_hierarchy_unique
    UNIQUE NULLS NOT DISTINCT (
      domain_id,
      category_id,
      brand_id,
      product_id,
      use_context_id
    )
);
