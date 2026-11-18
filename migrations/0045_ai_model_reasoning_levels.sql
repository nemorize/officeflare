ALTER TABLE ai_model_providers
ADD COLUMN reasoning_levels_json TEXT CHECK (
  reasoning_levels_json IS NULL
  OR (json_valid(reasoning_levels_json) AND json_type(reasoning_levels_json) = 'array')
);
