ANALYZE blue
WHEN (blue.first_blood OR red.first_blood)
  AND first_blood.time < 5m
RETURN win_rate()
