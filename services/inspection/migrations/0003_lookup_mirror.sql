-- The deficiency and action-code masters now live in the service-kit mirror (lookup_mirror), which every
-- service carries and which mdm.lookup.changed keeps current. The private copy is retired.
DROP TABLE IF EXISTS lookups;
