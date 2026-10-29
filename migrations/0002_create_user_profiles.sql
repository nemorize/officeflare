-- All field definitions are managed by administrators.
-- label is a locale map: {"default":"부서","en":"Department"}.
-- Choices use stable values: [{"value":"engineering","label":{"default":"개발"}}].
CREATE TABLE user_profile_fields (
  id TEXT PRIMARY KEY NOT NULL,
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL CHECK (
    CASE
      WHEN json_valid(label) THEN
        json_type(label) = 'object'
        AND COALESCE(json_type(label, '$.default') = 'text', 0)
        AND COALESCE(length(trim(json_extract(label, '$.default'))) > 0, 0)
      ELSE 0
    END
  ),
  value_type TEXT NOT NULL CHECK (
    value_type IN ('text', 'number', 'boolean', 'date', 'url', 'select', 'multiselect')
  ),
  -- private: the account owner and administrators; organization: all members.
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (
    visibility IN ('private', 'organization', 'admin')
  ),
  editable_by TEXT NOT NULL DEFAULT 'admin' CHECK (editable_by IN ('admin', 'user')),
  required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1)),
  options_json TEXT CHECK (
    CASE
      WHEN options_json IS NULL THEN 1
      WHEN json_valid(options_json) THEN json_type(options_json) = 'array'
      ELSE 0
    END
  ),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER,
  CHECK (
    CASE
      WHEN value_type IN ('select', 'multiselect') THEN
        options_json IS NOT NULL
        AND json_array_length(options_json) > 0
      ELSE options_json IS NULL
    END
  )
)
STRICT;

-- Values are JSON: "engineering", 42, true, or ["engineering", "design"].
-- Unset values have no row; type/choice validation and access policies belong in the API.
-- Use users.id rather than email so reassigning an address cannot transfer profile data.
CREATE TABLE user_profiles (
  user_id TEXT NOT NULL REFERENCES users (id)
    ON DELETE CASCADE,
  field_id TEXT NOT NULL REFERENCES user_profile_fields (id)
    ON DELETE CASCADE,
  value TEXT NOT NULL CHECK (
    CASE
      WHEN json_valid(value) THEN
        json_type(value) IN ('text', 'integer', 'real', 'true', 'false', 'array')
      ELSE 0
    END
  ),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, field_id)
)
STRICT;

CREATE INDEX user_profiles_field_id_index ON user_profiles (field_id);
