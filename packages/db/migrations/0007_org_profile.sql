-- Organisation profile and branding: the company details and logo that
-- appear on generated documents (Delivery Challans and later PDFs).
-- Content stays presentation-level — issued snapshots keep the legal
-- record; branding is applied at render time (template dc-v2).

ALTER TABLE organisations
  ADD COLUMN address text
    CHECK (address IS NULL OR length(btrim(address)) BETWEEN 1 AND 600),
  ADD COLUMN gstin text
    CHECK (gstin IS NULL OR gstin ~ '^[0-9A-Z]{15}$'),
  ADD COLUMN contact_phone text
    CHECK (contact_phone IS NULL OR length(btrim(contact_phone)) BETWEEN 3 AND 30),
  ADD COLUMN contact_email text
    CHECK (contact_email IS NULL OR length(btrim(contact_email)) BETWEEN 3 AND 200),
  ADD COLUMN logo_object_key text,
  ADD COLUMN logo_media_type text
    CHECK (logo_media_type IS NULL OR logo_media_type IN ('image/png', 'image/jpeg'));

-- Both logo columns travel together.
ALTER TABLE organisations
  ADD CONSTRAINT organisations_logo_pair
    CHECK ((logo_object_key IS NULL) = (logo_media_type IS NULL));
