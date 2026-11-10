ALTER TABLE users ADD COLUMN time_zone TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE users ADD COLUMN regional_format TEXT NOT NULL DEFAULT 'en';

UPDATE users
SET
  time_zone = (SELECT time_zone FROM calendar_preferences WHERE user_id = users.id),
  regional_format = (SELECT locale FROM calendar_preferences WHERE user_id = users.id)
WHERE EXISTS (SELECT 1 FROM calendar_preferences WHERE user_id = users.id);

ALTER TABLE calendar_preferences DROP COLUMN time_zone;
ALTER TABLE calendar_preferences DROP COLUMN locale;
