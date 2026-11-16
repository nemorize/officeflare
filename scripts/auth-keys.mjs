import { generateKeyPair, exportJWK } from "jose";
import { randomBytes, randomUUID } from "node:crypto";

export const managedSecretNames = [
  "AUTH_SIGNING_KEYS",
  "MFA_ENCRYPTION_KEYS",
  "MAIL_ENCRYPTION_KEY",
];
export async function generateAuthKeys() {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const kid = randomUUID();
  return {
    AUTH_SIGNING_KEYS: JSON.stringify({
      active_kid: kid,
      keys: [{ ...(await exportJWK(privateKey)), kid }],
    }),
    MFA_ENCRYPTION_KEYS: JSON.stringify({
      active_version: 1,
      keys: { 1: randomBytes(32).toString("base64url") },
    }),
    MAIL_ENCRYPTION_KEY: randomBytes(32).toString("base64url"),
  };
}
