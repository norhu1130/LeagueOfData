ANALYZE blue
WHEN blue.first_blood
  AND first_blood.time BETWEEN 2m AND 10m
RETURN win_rate()
