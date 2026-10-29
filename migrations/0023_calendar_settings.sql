ALTER TABLE calendar_preferences
ADD COLUMN remember_view INTEGER NOT NULL DEFAULT 1 CHECK (remember_view IN (0, 1));
ALTER TABLE calendar_preferences
ADD COLUMN last_view TEXT CHECK (
  last_view IS NULL
  OR last_view IN ('day', 'week', 'month', 'agenda')
);
ALTER TABLE calendar_preferences
ADD COLUMN default_calendar_id TEXT REFERENCES calendars (id)
  ON DELETE SET NULL;
