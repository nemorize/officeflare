export const COLLABORATION_PROTOCOL = "officeflare.collaboration.v1";
export const MAX_UPDATE_BYTES = 1024 * 1024;
export const MAX_STATE_BYTES = 1536 * 1024;
export type CollaborationCapabilities = {
  read: boolean;
  write: boolean;
  history: boolean;
  restore: boolean;
};
export type CollaborationStatus =
  "connecting" | "saved" | "saving" | "offline" | "readonly" | "revoked" | "reset" | "error";
export interface CollaborationParticipant {
  connection_id: string;
  user_id: string;
  name: string;
  color: string;
}
export function encodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export function decodeBytes(value: unknown, limit = MAX_UPDATE_BYTES): Uint8Array {
  if (typeof value !== "string" || value.length > Math.ceil(limit / 3) * 4 + 4)
    throw new Error("invalid_update");
  const binary = atob(value);
  if (binary.length > limit) throw new Error("update_too_large");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** Machine-readable protocol faults; clients translate status codes at the UI boundary. */
export class CollaborationFault extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "CollaborationFault";
  }
}
