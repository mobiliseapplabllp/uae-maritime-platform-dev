-- Spatial storage for the track store.
--
-- PostGIS is what the RFP commits to and what this uses when the cluster has it. It is not bundled
-- with Homebrew's PostgreSQL, which is how the platform runs on a developer's machine, so the
-- migration degrades instead of failing: lat/lon numerics stay the canonical value everywhere, and
-- the geography column, its index and the geodesic operators are added only where the extension
-- exists. A service that cannot load PostGIS still boots, still ingests and still answers spatial
-- questions — from bounding-box arithmetic rather than a spatial index.

DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS postgis;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'postgis is unavailable (%); the track store keeps numeric lat/lon only', SQLERRM;
  END;
END $$;

-- Named sea areas: port limits, anchorages, approach channels, restricted zones. Geometry is stored
-- as GeoJSON so the shape survives without PostGIS, with a bounding box alongside for the cheap
-- first-pass filter that both modes use before any exact test.
CREATE TABLE IF NOT EXISTS geofences (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  name_ar     text,
  kind        text NOT NULL CHECK (kind IN ('PORT_LIMIT','ANCHORAGE','CHANNEL','RESTRICTED','TSS','FISHING','CUSTOM')),
  -- What entering or leaving this area should raise, if anything.
  alert_on    text NOT NULL DEFAULT 'NONE' CHECK (alert_on IN ('NONE','ENTRY','EXIT','BOTH')),
  geojson     jsonb NOT NULL,
  min_lat     numeric(9,6) NOT NULL,
  max_lat     numeric(9,6) NOT NULL,
  min_lon     numeric(9,6) NOT NULL,
  max_lon     numeric(9,6) NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS geofences_bbox_idx ON geofences (min_lat, max_lat, min_lon, max_lon) WHERE active;

-- Every crossing, so an operator can answer "when did she enter the anchorage" from a row rather
-- than by replaying a track.
CREATE TABLE IF NOT EXISTS geofence_events (
  id          bigserial PRIMARY KEY,
  geofence_id uuid NOT NULL REFERENCES geofences(id) ON DELETE CASCADE,
  vessel_id   text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('ENTRY','EXIT')),
  at          timestamptz NOT NULL DEFAULT now(),
  lat         numeric(9,6) NOT NULL,
  lon         numeric(9,6) NOT NULL
);
CREATE INDEX IF NOT EXISTS geofence_events_vessel_idx ON geofence_events (vessel_id, at DESC);
CREATE INDEX IF NOT EXISTS geofence_events_fence_idx ON geofence_events (geofence_id, at DESC);

-- Geography columns, index and sync trigger: only where PostGIS actually loaded.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') THEN
    ALTER TABLE positions        ADD COLUMN IF NOT EXISTS geog geography(Point, 4326);
    ALTER TABLE position_history ADD COLUMN IF NOT EXISTS geog geography(Point, 4326);
    ALTER TABLE geofences        ADD COLUMN IF NOT EXISTS area geography(Polygon, 4326);

    UPDATE positions        SET geog = ST_SetSRID(ST_MakePoint(lon::float8, lat::float8), 4326)::geography WHERE geog IS NULL;
    UPDATE position_history SET geog = ST_SetSRID(ST_MakePoint(lon::float8, lat::float8), 4326)::geography WHERE geog IS NULL;

    CREATE INDEX IF NOT EXISTS positions_geog_idx        ON positions        USING GIST (geog);
    CREATE INDEX IF NOT EXISTS position_history_geog_idx ON position_history USING GIST (geog);
    CREATE INDEX IF NOT EXISTS geofences_area_idx        ON geofences        USING GIST (area);

    -- A trigger rather than application code: the AIS adapter, the seed and any future writer all
    -- keep the geography in step without any of them having to know PostGIS is present.
    CREATE OR REPLACE FUNCTION sync_geog() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      NEW.geog := ST_SetSRID(ST_MakePoint(NEW.lon::float8, NEW.lat::float8), 4326)::geography;
      RETURN NEW;
    END $fn$;

    DROP TRIGGER IF EXISTS positions_geog_sync ON positions;
    CREATE TRIGGER positions_geog_sync BEFORE INSERT OR UPDATE OF lat, lon ON positions
      FOR EACH ROW EXECUTE FUNCTION sync_geog();
    DROP TRIGGER IF EXISTS position_history_geog_sync ON position_history;
    CREATE TRIGGER position_history_geog_sync BEFORE INSERT OR UPDATE OF lat, lon ON position_history
      FOR EACH ROW EXECUTE FUNCTION sync_geog();

    CREATE OR REPLACE FUNCTION sync_fence_area() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      NEW.area := ST_SetSRID(ST_GeomFromGeoJSON(NEW.geojson::text), 4326)::geography;
      RETURN NEW;
    END $fn$;
    DROP TRIGGER IF EXISTS geofences_area_sync ON geofences;
    CREATE TRIGGER geofences_area_sync BEFORE INSERT OR UPDATE OF geojson ON geofences
      FOR EACH ROW EXECUTE FUNCTION sync_fence_area();
  END IF;
END $$;
