import { t } from "../../shared/i18n/index.ts";
import {
  parseProviderConfig,
  parseProviderSecrets,
  parseProviderSecretUpdates,
  provider,
} from "./providers";
import { seal, unseal } from "./secrets";
import { text } from "./input";
import { fail, id, type Connection, type Domain } from "./types";

export type ProviderDirection = "inbound" | "outbound";
export interface DomainProviderSettings {
  id: string;
  provider: string;
  config: Record<string, string>;
  secret_ciphertext?: string | null;
  secret_nonce?: string | null;
}
export type DomainProviders = Record<ProviderDirection, DomainProviderSettings | null>;
export function domainProviders(domain: Pick<Domain, "provider_settings_json">): DomainProviders {
  const value = JSON.parse(domain.provider_settings_json) as DomainProviders;
  return { inbound: value.inbound ?? null, outbound: value.outbound ?? null };
}
export function domainConnection(
  domain: Pick<Domain, "name" | "version" | "provider_settings_json">,
  direction: ProviderDirection,
): Connection | null {
  const settings = domainProviders(domain)[direction];
  if (!settings) return null;
  const selected = provider(settings.provider);
  if (!selected.capabilities[direction === "inbound" ? "receive" : "send"])
    fail(409, t("domainProviders.unsupportedDirection"));
  return {
    id: settings.id,
    provider: settings.provider,
    name: domain.name,
    enabled: 1,
    version: domain.version,
    config_json: JSON.stringify(settings.config),
    secret_ciphertext: settings.secret_ciphertext,
    secret_nonce: settings.secret_nonce,
  };
}
export function publicMailDomain(domain: Domain, readConfiguration: boolean) {
  const { provider_settings_json: _, ...entry } = domain;
  const settings = domainProviders(domain);
  const publicSettings = (value: DomainProviderSettings | null) =>
    value && {
      provider: value.provider,
      ...(readConfiguration ? { config: value.config } : {}),
      secret_configured: !!value.secret_ciphertext,
    };
  return {
    ...entry,
    inbound_provider: settings.inbound?.provider ?? null,
    outbound_provider: settings.outbound?.provider ?? null,
    provider_settings: {
      inbound: publicSettings(settings.inbound),
      outbound: publicSettings(settings.outbound),
    },
  };
}
export async function updateDomainProviders(
  env: Env,
  current: DomainProviders,
  value: unknown,
): Promise<DomainProviders> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !["inbound", "outbound"].includes(key))
  )
    fail(400, t("domainProviders.invalidSettings"));
  const changes = value as Record<string, unknown>;
  const next = { ...current };
  for (const direction of ["inbound", "outbound"] as const) {
    if (!(direction in changes)) continue;
    const change = changes[direction];
    if (change === null) {
      next[direction] = null;
      continue;
    }
    if (
      !change ||
      typeof change !== "object" ||
      Array.isArray(change) ||
      Object.keys(change).some((key) => !["provider", "config", "secrets"].includes(key))
    )
      fail(400, t("domainProviders.invalidSettings"));
    const input = change as Record<string, unknown>,
      previous = current[direction];
    const selected = provider(
      text("provider" in input ? input.provider : previous?.provider, "provider", 64),
    );
    if (!selected.capabilities[direction === "inbound" ? "receive" : "send"])
      fail(400, t("domainProviders.unsupportedDirection"));
    const same = previous?.provider === selected.id;
    const config = parseProviderConfig(
      "config" in input ? input.config : same ? previous.config : undefined,
      selected,
    );
    let ciphertext = same ? (previous.secret_ciphertext ?? null) : null;
    let nonce = same ? (previous.secret_nonce ?? null) : null;
    const updates =
      input.secrets === undefined ? {} : parseProviderSecretUpdates(input.secrets, selected);
    if (
      !same ||
      Object.keys(updates).length ||
      (selected.secret_fields.some((field) => field.required) && !ciphertext)
    ) {
      const saved =
        ciphertext && nonce
          ? (JSON.parse(await unseal(env, ciphertext, nonce)) as Record<string, unknown>)
          : {};
      const secrets = parseProviderSecrets({ ...saved, ...updates }, selected);
      const encrypted = Object.keys(secrets).length
        ? await seal(env, JSON.stringify(secrets))
        : null;
      ciphertext = encrypted?.ciphertext ?? null;
      nonce = encrypted?.nonce ?? null;
    }
    next[direction] = {
      id: same ? previous.id : id(),
      provider: selected.id,
      config,
      secret_ciphertext: ciphertext,
      secret_nonce: nonce,
    };
  }
  return next;
}
export const defaultDomainProviders = (): DomainProviders => ({
  inbound: { id: id(), provider: "cloudflare", config: {} },
  outbound: { id: id(), provider: "cloudflare", config: {} },
});
