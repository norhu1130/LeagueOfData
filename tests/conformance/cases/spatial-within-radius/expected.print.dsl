ANALYZE blue
WHEN death.position WITHIN 1000 OF blue.top_outer_turret
RETURN win_rate()
