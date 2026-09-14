ANALYZE blue
WHEN blue.first_blood
GROUP BY bucket(first_blood.time, 60s)
RETURN win_rate()
