ANALYZE blue
WHEN blue.first_blood
GROUP BY position_region
RETURN blue.win_rate()
