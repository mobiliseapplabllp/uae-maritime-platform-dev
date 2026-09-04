-- What the corpus was last indexed by. The vectors depend on the tokeniser, on which fields are indexed and
-- on the embedder, none of which a migration can see: change any of them and every stored vector is stale
-- while looking perfectly valid. Recording the version the index was built with is what lets a service
-- notice that at boot and rebuild, instead of serving a stale ranking indefinitely.
CREATE TABLE IF NOT EXISTS corpus_index (
  id        boolean PRIMARY KEY DEFAULT true CHECK (id),
  version   text NOT NULL DEFAULT '',
  documents int NOT NULL DEFAULT 0,
  terms     int NOT NULL DEFAULT 0,
  built_at  timestamptz NOT NULL DEFAULT now()
);
