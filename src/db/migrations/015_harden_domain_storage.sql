UPDATE domains
SET display_domain = normalized_domain,
    updated_at = now()
WHERE display_domain IS DISTINCT FROM normalized_domain;

ALTER TABLE domains
  ADD CONSTRAINT domains_display_normalized_check CHECK (
    display_domain IS NULL
    OR display_domain = normalized_domain
  );
