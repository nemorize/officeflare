import { all, connection, first } from "./control";
import type { Domain, RuleCondition } from "./types";

export interface RoutingRule {
  id: string;
  domain_id: string;
  name: string;
  priority: number;
  enabled: number;
  conditions_json: string;
  action: "store" | "forward" | "reject";
  forward_to: string | null;
  reject_reason: string | null;
  version: number;
}

export async function incomingRoute(env: Env, message: ForwardableEmailMessage) {
  const domain = await first<Domain>(
    env,
    "SELECT * FROM mail_domains WHERE name=? AND inbound_enabled=1",
    message.to.split("@").at(-1)!.toLowerCase(),
  );
  if (!domain?.inbound_connection_id) return null;
  const selected = await connection(env, domain.inbound_connection_id);
  const fields = {
    from: message.from,
    to: message.to,
    subject: message.headers.get("subject") ?? "",
  };
  const rules = await all<RoutingRule>(
    env,
    "SELECT * FROM mail_routing_rules WHERE domain_id=? AND enabled=1 ORDER BY priority DESC,id",
    domain.id,
  );
  for (const rule of rules) {
    if (
      !(JSON.parse(rule.conditions_json) as RuleCondition[]).every((condition) => {
        const source = fields[condition.field as keyof typeof fields].toLowerCase(),
          value = condition.value.toLowerCase();
        return condition.operator === "contains"
          ? source.includes(value)
          : condition.operator === "equals"
            ? source === value
            : condition.operator === "prefix"
              ? source.startsWith(value)
              : source.endsWith(value);
      })
    )
      continue;
    return { ...rule, provider: selected.provider, connection_id: selected.id };
  }
  return null;
}
