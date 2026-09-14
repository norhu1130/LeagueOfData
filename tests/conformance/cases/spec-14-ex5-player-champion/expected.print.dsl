ANALYZE player
WHEN player.champion = "Darius"
  AND player.role = "TOP"
  AND player.gold_diff(10:00) >= 500
RETURN player.win_rate()
