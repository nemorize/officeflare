import { t } from "../../shared/i18n/index.ts";
import type { AIEnv, AIRequest } from "./types";

export interface ConsumerDefinition {
  principals: readonly ("user" | "service")[];
  permission?: string;
  billing: "actor" | "service" | "resource_owner";
  resolveOwner?: (env: AIEnv, request: AIRequest) => Promise<string>;
}
// This registry is extended by trusted domain modules, never by request JSON.
const registry = new Map<string, ConsumerDefinition>([
  ["hub.chat", { principals: ["user"], permission: "ai.runs.create", billing: "actor" }],
  ["mcp.tools", { principals: ["user"], billing: "actor" }],
]);
export function registerAIConsumer(key: string, definition: ConsumerDefinition) {
  if (registry.has(key) || !/^[a-z][a-z0-9_.-]{1,80}$/.test(key))
    throw new Error(t("ai.providerError"));
  registry.set(key, definition);
}
export const consumerDefinition = (key: string) => registry.get(key);
export const consumerCatalog = () =>
  [...registry].map(([key, definition]) => ({
    key,
    principals: definition.principals,
    billing: definition.billing,
  }));
