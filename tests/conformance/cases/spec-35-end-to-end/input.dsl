ANALYZE blue
WHEN blue.first_blood
  AND first_blood.position IN region("custom_top_region")
RETURN avg(duration(blue.first_blood, blue.first_turret_destroy)) AS time_to_turret, blue.win_rate AS win_rate
