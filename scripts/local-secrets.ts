import { unstable_getVarsForDev, type Unstable_Config } from "wrangler";

type LocalConfig = Pick<Unstable_Config, "configPath" | "vars" | "secrets">;

// Production still validates secrets.required. Local sessions also load optional
// values actually present in .dev.vars/.env, without declaring them required for deploy.
export function localSecretSettings(
  config: LocalConfig,
  environment?: string,
  envFiles?: string[],
) {
  if (!config.secrets) return undefined;
  const bindings = unstable_getVarsForDev(
    config.configPath,
    envFiles,
    config.vars,
    environment,
    true,
  );
  return {
    ...config.secrets,
    required: [
      ...new Set([
        ...(config.secrets.required ?? []),
        ...Object.entries(bindings)
          .filter(([, binding]) => binding.type === "secret_text")
          .map(([name]) => name),
      ]),
    ],
  };
}
