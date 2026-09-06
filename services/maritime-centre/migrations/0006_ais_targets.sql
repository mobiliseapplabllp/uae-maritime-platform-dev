-- Every ship the AIS feed reports, registered with us or not. The picture draws all of them; the case files, the
-- derived alerts and the register concern only the ships on our own register (vessel_id set).
CREATE TABLE IF NOT EXISTS ais_targets (
  mmsi            text PRIMARY KEY,
  imo             text NOT NULL DEFAULT '',
  name            text NOT NULL DEFAULT '',
  call_sign       text NOT NULL DEFAULT '',
  ship_type       int,
  category        text NOT NULL DEFAULT 'other',     -- the legend's colour class: cargo, tanker, passenger, highspeed, tug, fishing, pleasure, other
  type_label      text NOT NULL DEFAULT '',
  lat             numeric(9,5) NOT NULL,
  lon             numeric(9,5) NOT NULL,
  sog             numeric(5,1) NOT NULL DEFAULT 0,
  cog             int NOT NULL DEFAULT 0,
  heading         int,
  nav_status      text NOT NULL DEFAULT 'UNDEFINED',
  nav_status_code int,
  destination     text NOT NULL DEFAULT '',
  eta             text NOT NULL DEFAULT '',
  draught         numeric(4,1),
  length          int,
  width           int,
  source          text NOT NULL DEFAULT '',
  vessel_id       text,                              -- set when the ship is on our register
  received_at     timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ais_targets_bbox_idx ON ais_targets (lat, lon);
CREATE INDEX IF NOT EXISTS ais_targets_received_idx ON ais_targets (received_at DESC);
CREATE INDEX IF NOT EXISTS ais_targets_vessel_idx ON ais_targets (vessel_id) WHERE vessel_id IS NOT NULL;

-- A thinned track per ship: one point every few minutes, kept for two days, so a past track can be drawn for any target.
CREATE TABLE IF NOT EXISTS ais_target_history (
  mmsi        text NOT NULL,
  lat         numeric(9,5) NOT NULL,
  lon         numeric(9,5) NOT NULL,
  sog         numeric(5,1) NOT NULL DEFAULT 0,
  cog         int NOT NULL DEFAULT 0,
  received_at timestamptz NOT NULL,
  PRIMARY KEY (mmsi, received_at)
);
CREATE INDEX IF NOT EXISTS ais_target_history_at_idx ON ais_target_history (received_at);

-- "My fleet": the ships a person follows on the picture.
CREATE TABLE IF NOT EXISTS watch_list (
  user_id   text NOT NULL,
  mmsi      text NOT NULL,
  vessel_id text,
  name      text NOT NULL DEFAULT '',
  added_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, mmsi)
);
