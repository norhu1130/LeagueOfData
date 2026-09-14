ANALYZE blue
WHEN blue.first_blood
RETURN avg(duration(blue.first_blood, blue.first_turret_destroy))
