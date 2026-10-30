-- Uploading the same adjustment CSV twice (e.g. a double-click) posted every
-- row to the ledger twice. Record a hash of the normalised rows and reject a
-- second import with identical content. Existing rows keep NULL.

ALTER TABLE adjustment_imports ADD COLUMN content_sha256 TEXT;

CREATE UNIQUE INDEX uq_adjustment_imports_content_sha256
    ON adjustment_imports (content_sha256)
    WHERE content_sha256 IS NOT NULL;
