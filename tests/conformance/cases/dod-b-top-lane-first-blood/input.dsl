ANALYZE blue
WHEN blue.first_blood
  AND first_blood.position IN region("top_lane")
RETURN blue.win_rate
