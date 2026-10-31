ALTER TABLE users
ADD COLUMN language TEXT NOT NULL DEFAULT 'system' CHECK (language IN ('system', 'en', 'ko', 'ja'));
