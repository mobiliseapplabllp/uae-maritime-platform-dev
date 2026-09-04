-- Vector storage for the retrieval corpus.
--
-- pgvector is what the RFP commits to and what this uses when the cluster has it. It is not bundled with
-- the PostgreSQL a developer installs from Homebrew, so the migration degrades rather than failing: the
-- numeric vector stays canonical in `dense` either way, and the vector column, its ANN index and the
-- distance operators are added only where the extension loaded. A service that cannot load pgvector still
-- boots, still indexes and still answers — ranking in process over the same numbers instead of in SQL.

DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pgvector is unavailable (%); retrieval ranks in process from the numeric vector', SQLERRM;
  END;
END $$;

-- The canonical vector: 256 numbers, written by the indexer, readable and rankable without any extension.
ALTER TABLE corpus ADD COLUMN IF NOT EXISTS dense real[];

-- The searchable copy, and the trigger that keeps it equal to the canonical one. Both exist only where the
-- extension does; everywhere else `dense` is the whole story.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    EXECUTE 'ALTER TABLE corpus ADD COLUMN IF NOT EXISTS embedding vector(256)';

    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION sync_embedding() RETURNS trigger AS $body$
      BEGIN
        -- a partial or absent vector is stored as nothing rather than as a wrong shape pgvector would reject
        IF NEW.dense IS NOT NULL AND array_length(NEW.dense, 1) = 256 THEN
          NEW.embedding := NEW.dense::vector;
        ELSE
          NEW.embedding := NULL;
        END IF;
        RETURN NEW;
      END;
      $body$ LANGUAGE plpgsql
    $fn$;

    DROP TRIGGER IF EXISTS corpus_embedding_sync ON corpus;
    EXECUTE 'CREATE TRIGGER corpus_embedding_sync BEFORE INSERT OR UPDATE OF dense ON corpus
               FOR EACH ROW EXECUTE FUNCTION sync_embedding()';

    -- Cosine, because the vectors are L2-normalised and cosine is what the in-process path scores with:
    -- the two modes have to agree on the ordering or the fallback would not be a fallback.
    EXECUTE 'CREATE INDEX IF NOT EXISTS corpus_embedding_idx ON corpus USING hnsw (embedding vector_cosine_ops)';

    -- Any row written before the column existed gets its searchable copy on the way past.
    EXECUTE 'UPDATE corpus SET dense = dense WHERE dense IS NOT NULL AND embedding IS NULL';
  END IF;
END $$;

-- The permission filter runs in the WHERE clause of the recall query, ahead of the ordering, so this index
-- is what keeps scoping-before-ranking from costing a sequential scan.
CREATE INDEX IF NOT EXISTS corpus_permission_kind_idx ON corpus(permission, kind);
