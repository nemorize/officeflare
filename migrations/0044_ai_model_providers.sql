-- Console configuration is provider + credentials, then model + ordered providers.
-- Existing account, deployment and route IDs remain valid for usage and audit history.
ALTER TABLE ai_providers ADD COLUMN pool_id TEXT REFERENCES ai_account_pools (id);
ALTER TABLE ai_providers ADD COLUMN gateway_id TEXT REFERENCES ai_gateways (id);
ALTER TABLE ai_models ADD COLUMN profile_id TEXT REFERENCES ai_profiles (id);
ALTER TABLE ai_profiles ADD COLUMN model_id TEXT REFERENCES ai_models (id);
ALTER TABLE ai_model_deployments ADD COLUMN cooldown_until INTEGER;
ALTER TABLE ai_model_deployments ADD COLUMN last_error_code TEXT;

UPDATE ai_providers
SET pool_id = (
  SELECT p.id
  FROM ai_account_pools p
  WHERE p.provider_id = ai_providers.id
  ORDER BY p.enabled DESC, p.created_at, p.id
  LIMIT 1
);
UPDATE ai_providers
SET gateway_id = (
  SELECT r.gateway_id
  FROM ai_profile_routes r
  WHERE r.provider_id = ai_providers.id AND r.gateway_id IS NOT NULL
  ORDER BY r.enabled DESC, r.priority, r.id
  LIMIT 1
);

CREATE TABLE ai_model_providers (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES ai_models (id),
  provider_id TEXT NOT NULL REFERENCES ai_providers (id),
  deployment_id TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  gateway_id TEXT REFERENCES ai_gateways (id),
  priority INTEGER NOT NULL CHECK (priority >= 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  UNIQUE (model_id, priority),
  UNIQUE (model_id, deployment_id),
  FOREIGN KEY (provider_id, deployment_id) REFERENCES ai_model_deployments (provider_id, id),
  FOREIGN KEY (provider_id, pool_id) REFERENCES ai_account_pools (provider_id, id)
)
STRICT;
CREATE INDEX ai_model_providers_deployment ON ai_model_providers (deployment_id, model_id);

INSERT INTO ai_model_providers
  (id, model_id, provider_id, deployment_id, pool_id, gateway_id, priority, enabled)
SELECT
  'legacy:' || d.id,
  d.model_id,
  d.provider_id,
  d.id,
  COALESCE(
    (
      SELECT r.pool_id
      FROM ai_profile_routes r
      WHERE r.deployment_id = d.id
      ORDER BY r.enabled DESC, r.priority, r.id
      LIMIT 1
    ),
    p.pool_id
  ),
  (
    SELECT r.gateway_id
    FROM ai_profile_routes r
    WHERE r.deployment_id = d.id
    ORDER BY r.enabled DESC, r.priority, r.id
    LIMIT 1
  ),
  row_number() OVER (
    PARTITION BY d.model_id
    ORDER BY
      COALESCE((SELECT min(r.priority) FROM ai_profile_routes r WHERE r.deployment_id = d.id), 0),
      d.id
  ) - 1,
  d.enabled
FROM ai_model_deployments d
JOIN ai_providers p ON p.id = d.provider_id
WHERE p.pool_id IS NOT NULL;

UPDATE ai_profiles
SET model_id = (
  SELECT min(d.model_id)
  FROM ai_profile_routes r
  JOIN ai_model_deployments d ON d.id = r.deployment_id
  WHERE r.profile_id = ai_profiles.id AND r.enabled = 1
  HAVING count(DISTINCT d.model_id) = 1
);
UPDATE ai_models
SET profile_id = (
  SELECT p.id
  FROM ai_profiles p
  WHERE p.model_id = ai_models.id
  ORDER BY p.created_at, p.id
  LIMIT 1
);

CREATE TRIGGER ai_model_providers_epoch_insert
AFTER INSERT ON ai_model_providers
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_model_providers_epoch_update
AFTER UPDATE ON ai_model_providers
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_model_providers_epoch_delete
AFTER DELETE ON ai_model_providers
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
