-- DuckDB view definitions executed during backend startup.
--
-- The loader replaces {root} with the silver-directory path.
--
-- hive_partitioning=1 restores patch/queue/region columns from paths, allowing filters to
-- prune files even though those columns are absent from physical files.

CREATE OR REPLACE VIEW matches AS
  SELECT * FROM read_parquet('{root}/matches/**/*.parquet', hive_partitioning=1, union_by_name=1);

CREATE OR REPLACE VIEW participants AS
  SELECT * FROM read_parquet('{root}/participants/**/*.parquet', hive_partitioning=1, union_by_name=1);

CREATE OR REPLACE VIEW teams AS
  SELECT * FROM read_parquet('{root}/teams/**/*.parquet', hive_partitioning=1, union_by_name=1);

CREATE OR REPLACE VIEW events AS
  SELECT * FROM read_parquet('{root}/events/**/*.parquet', hive_partitioning=1, union_by_name=1)
  UNION ALL BY NAME
  -- Schema-v3 datasets have no ITEM_UNDO afterId. Keep them readable, though their restored item
  -- cannot be inferred until bronze data is normalized again with schema v4.
  SELECT NULL::USMALLINT AS item_after_id WHERE FALSE;

CREATE OR REPLACE VIEW timeline_participant_frames AS
  SELECT * FROM read_parquet('{root}/timeline_participant_frames/**/*.parquet',
                             hive_partitioning=1, union_by_name=1);

CREATE OR REPLACE VIEW timeline_team_frames AS
  SELECT * FROM read_parquet('{root}/timeline_team_frames/**/*.parquet',
                             hive_partitioning=1, union_by_name=1);

CREATE OR REPLACE VIEW match_summary AS
  SELECT * FROM read_parquet('{root}/match_summary/**/*.parquet',
                             hive_partitioning=1, union_by_name=1);

-- --------------------------------------------------------------------------
-- Derived views
--
-- Death, assist, and first blood are derived rather than duplicated physical rows. Store each
-- kill once and expose multiple analytical perspectives through views.
-- --------------------------------------------------------------------------

-- Deaths project kills from the victim perspective at the same position.
CREATE OR REPLACE VIEW v_deaths AS
  SELECT
    e.match_id, e.event_id, e.timestamp_ms, e.frame_idx,
    e.victim_id          AS participant_id,
    e.victim_team_id     AS team_id,
    e.victim_champion_id AS champion_id,
    victim.role          AS role,
    e.participant_id     AS killer_id,
    e.team_id            AS killer_team_id,
    e.assist_ids, e.assist_count,
    e.x_raw, e.y_raw, e.x_norm, e.y_norm, e.has_position
  FROM events e
  LEFT JOIN participants victim
    ON victim.match_id = e.match_id
   AND victim.participant_id = e.victim_id
  WHERE e.event_type = 'kill';

-- Assists unnest the LIST column without additional physical storage.
CREATE OR REPLACE VIEW v_event_assists AS
  SELECT
    match_id, event_id, timestamp_ms, team_id,
    x_norm, y_norm, has_position,
    UNNEST(assist_ids) AS assist_participant_id
  FROM events
  WHERE event_type = 'kill' AND assist_count > 0;

-- First blood occurs at most once per match.
CREATE OR REPLACE VIEW v_first_blood AS
  SELECT * FROM events
  WHERE event_type = 'kill' AND is_first_of_type;

-- Solo kills have no assists and often signal lane pressure.
CREATE OR REPLACE VIEW v_solo_kills AS
  SELECT * FROM events
  WHERE event_type = 'kill' AND coalesce(assist_count, 0) = 0;

-- A team's fourth elemental dragon grants Dragon Soul on Summoner's Rift. Elder is excluded.
CREATE OR REPLACE VIEW v_dragon_soul_acquired AS
  SELECT * EXCLUDE (dragon_number)
  FROM (
    SELECT
      events.*,
      row_number() OVER (
        PARTITION BY match_id, team_id
        ORDER BY timestamp_ms, event_id
      ) AS dragon_number
    FROM events
    WHERE event_type = 'dragon_kill'
      AND event_subtype IN (
        'FIRE_DRAGON', 'AIR_DRAGON', 'EARTH_DRAGON', 'WATER_DRAGON',
        'HEXTECH_DRAGON', 'CHEMTECH_DRAGON'
      )
  ) ranked_dragons
  WHERE dragon_number = 4;

-- First turret destruction per team.
CREATE OR REPLACE VIEW v_first_tower AS
  SELECT * FROM events
  WHERE event_type = 'turret_destroy' AND is_first_of_type;
