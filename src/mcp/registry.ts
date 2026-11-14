import { t } from "../../shared/i18n/index.ts";
import { createDatabase } from "../db";
import { permissionsFor } from "../authorization/access";
import { now } from "../auth/types";
import { executeMailTool, mailTools } from "../mail/protocols";
import { submitDraft } from "../mail/service";
import { fail } from "../ai/errors";
import { validateSchema } from "../ai/json-schema";
import { canonical, first, hash, identity, object, rows, statement, text } from "../ai/store";
import type { AIEnv, AIPrincipal, AITool, ObjectValue } from "../ai/types";
import { domainRequest } from "./domain";

export const scopes = [
  "mail.read",
  "mail.write",
  "mail.send",
  "contacts.read",
  "contacts.write",
  "drive.read",
  "drive.write",
  "calendar.read",
  "calendar.write",
] as const;
export type MCPScope = (typeof scopes)[number];
export interface ToolDefinition extends AITool {
  id: string;
  server: string;
  scope: MCPScope;
  permission: string;
  execution: "read" | "write" | "external";
  replay: "read_only" | "idempotent" | "reconcile" | "never";
  run: (
    env: AIEnv,
    principal: AIPrincipal,
    args: ObjectValue,
    operation: string,
  ) => Promise<unknown>;
}
export const field = { type: "string", maxLength: 200 };
const number = { type: "integer", minimum: 1 };
const query = { type: "string", maxLength: 255 };
const data = { type: "object", additionalProperties: true };
const schema = (properties: ObjectValue, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const path = (value: unknown) => encodeURIComponent(text(value, 200));
function tool(
  name: string,
  description: () => string,
  inputSchema: ObjectValue,
  scope: MCPScope,
  permission: string,
  execution: ToolDefinition["execution"],
  run: ToolDefinition["run"],
  replay?: ToolDefinition["replay"],
): ToolDefinition {
  return {
    id: "builtin:" + name + ":1",
    name,
    get description() {
      return description();
    },
    inputSchema,
    server: name.split(".")[0]!,
    scope,
    permission,
    execution,
    replay: replay ?? (execution === "read" ? "read_only" : "idempotent"),
    run,
  };
}
const builtin: ToolDefinition[] = [
  ...mailTools.map((entry) =>
    tool(
      "mail." + entry.name,
      () => entry.description,
      entry.inputSchema,
      entry.name === "create_draft" ? "mail.write" : "mail.read",
      "mail.access",
      entry.name === "create_draft" ? "write" : "read",
      async (env, principal, args, operation) => {
        const actor = await identity(env, principal);
        return executeMailTool(
          env,
          { user_id: actor.user.id, auth_version: actor.user.auth_version, api_key_id: null },
          entry.name,
          args,
          operation,
        );
      },
    ),
  ),
  tool(
    "mail.submit_draft",
    () => t("mcp.tool.submitDraft"),
    schema({ mailbox_id: field, draft_id: field, address_id: field, version: number }, [
      "mailbox_id",
      "draft_id",
      "address_id",
      "version",
    ]),
    "mail.send",
    "mail.access",
    "external",
    async (env, principal, args, operation) => {
      const actor = await identity(env, principal);
      return submitDraft(
        env,
        { user_id: actor.user.id, auth_version: actor.user.auth_version, api_key_id: null },
        String(args.mailbox_id),
        String(args.draft_id),
        { address_id: args.address_id, version: args.version },
        operation,
      );
    },
  ),
  tool(
    "contacts.search",
    () => t("mcp.tool.contactsSearch"),
    schema({ query, limit: { type: "integer", minimum: 1, maximum: 100 }, cursor: field }),
    "contacts.read",
    "contacts.access",
    "read",
    (env, principal, args) =>
      domainRequest(
        env,
        principal,
        "/api/contacts?" +
          new URLSearchParams({
            q: String(args.query ?? ""),
            limit: String(args.limit ?? 50),
            ...(args.cursor ? { cursor: String(args.cursor) } : {}),
          }),
      ),
  ),
  tool(
    "contacts.get",
    () => t("mcp.tool.contactsGet"),
    schema({ contact_id: field }, ["contact_id"]),
    "contacts.read",
    "contacts.access",
    "read",
    (env, principal, args) =>
      domainRequest(env, principal, "/api/contacts/" + path(args.contact_id)),
  ),
  tool(
    "contacts.create",
    () => t("mcp.tool.contactsCreate"),
    schema({ data }, ["data"]),
    "contacts.write",
    "contacts.entries.create",
    "write",
    (env, principal, args, operation) =>
      domainRequest(env, principal, "/api/contacts", "POST", args.data, operation),
  ),
  tool(
    "contacts.update",
    () => t("mcp.tool.contactsUpdate"),
    schema({ contact_id: field, version: number, data }, ["contact_id", "version", "data"]),
    "contacts.write",
    "contacts.entries.update",
    "write",
    (env, principal, args, operation) =>
      domainRequest(
        env,
        principal,
        "/api/contacts/" + path(args.contact_id),
        "PATCH",
        { ...object(args.data), version: args.version },
        operation,
      ),
  ),
  tool(
    "contacts.trash",
    () => t("mcp.tool.contactsTrash"),
    schema({ contact_id: field, version: number }, ["contact_id", "version"]),
    "contacts.write",
    "contacts.entries.delete",
    "write",
    (env, principal, args, operation) =>
      domainRequest(
        env,
        principal,
        "/api/contacts/" + path(args.contact_id) + "?version=" + args.version,
        "DELETE",
        undefined,
        operation,
      ),
  ),
  tool(
    "drive.search",
    () => t("mcp.tool.driveSearch"),
    schema({ query, parent_id: field, cursor: field }),
    "drive.read",
    "drive.access",
    "read",
    (env, principal, args) =>
      domainRequest(
        env,
        principal,
        "/api/drive/items?" +
          new URLSearchParams({
            view: "all",
            q: String(args.query ?? ""),
            parent_id: String(args.parent_id ?? "all"),
            limit: "50",
            ...(args.cursor ? { cursor: String(args.cursor) } : {}),
          }),
      ),
  ),
  tool(
    "drive.get",
    () => t("mcp.tool.driveGet"),
    schema({ item_id: field }, ["item_id"]),
    "drive.read",
    "drive.access",
    "read",
    (env, principal, args) =>
      domainRequest(env, principal, "/api/drive/items/" + path(args.item_id)),
  ),
  tool(
    "drive.read_text",
    () => t("mcp.tool.driveRead"),
    schema({ item_id: field }, ["item_id"]),
    "drive.read",
    "drive.files.download",
    "read",
    (env, principal, args) =>
      domainRequest(env, principal, "/api/drive/items/" + path(args.item_id) + "/content"),
  ),
  tool(
    "drive.create_folder",
    () => t("mcp.tool.driveFolder"),
    schema(
      {
        name: { type: "string", minLength: 1, maxLength: 255 },
        parent_id: { type: ["string", "null"] },
      },
      ["name"],
    ),
    "drive.write",
    "drive.files.create",
    "write",
    (env, principal, args, operation) =>
      domainRequest(env, principal, "/api/drive/folders", "POST", args, operation),
    "never",
  ),
  tool(
    "drive.rename",
    () => t("mcp.tool.driveRename"),
    schema(
      { item_id: field, version: number, name: { type: "string", minLength: 1, maxLength: 255 } },
      ["item_id", "version", "name"],
    ),
    "drive.write",
    "drive.files.update",
    "write",
    (env, principal, args, operation) =>
      domainRequest(
        env,
        principal,
        "/api/drive/items/" + path(args.item_id),
        "PATCH",
        { version: args.version, name: args.name },
        operation,
      ),
    "reconcile",
  ),
  tool(
    "drive.trash",
    () => t("mcp.tool.driveTrash"),
    schema({ item_id: field, version: number }, ["item_id", "version"]),
    "drive.write",
    "drive.files.delete",
    "write",
    (env, principal, args, operation) =>
      domainRequest(
        env,
        principal,
        "/api/drive/items/" + path(args.item_id),
        "PATCH",
        { version: args.version, trashed: true },
        operation,
      ),
    "reconcile",
  ),
  tool(
    "calendar.list",
    () => t("mcp.tool.calendarList"),
    schema({}),
    "calendar.read",
    "calendar.access",
    "read",
    (env, principal) => domainRequest(env, principal, "/api/calendar/calendars"),
  ),
  tool(
    "calendar.events",
    () => t("mcp.tool.calendarEvents"),
    schema(
      {
        calendar_id: field,
        time_min: { type: "string", maxLength: 64 },
        time_max: { type: "string", maxLength: 64 },
        query,
        cursor: field,
      },
      ["time_min", "time_max"],
    ),
    "calendar.read",
    "calendar.access",
    "read",
    (env, principal, args) =>
      domainRequest(
        env,
        principal,
        "/api/calendar/events?" +
          new URLSearchParams({
            time_min: String(args.time_min),
            time_max: String(args.time_max),
            ...(args.calendar_id ? { calendar_ids: String(args.calendar_id) } : {}),
            q: String(args.query ?? ""),
            limit: "50",
            ...(args.cursor ? { cursor: String(args.cursor) } : {}),
          }),
      ),
  ),
  tool(
    "calendar.get_event",
    () => t("mcp.tool.calendarGet"),
    schema({ calendar_id: field, event_id: field }, ["calendar_id", "event_id"]),
    "calendar.read",
    "calendar.access",
    "read",
    (env, principal, args) =>
      domainRequest(
        env,
        principal,
        "/api/calendar/calendars/" + path(args.calendar_id) + "/events/" + path(args.event_id),
      ),
  ),
  tool(
    "calendar.create_event",
    () => t("mcp.tool.calendarCreate"),
    schema({ calendar_id: field, data }, ["calendar_id", "data"]),
    "calendar.write",
    "calendar.events.create",
    "external",
    (env, principal, args, operation) =>
      domainRequest(
        env,
        principal,
        "/api/calendar/calendars/" + path(args.calendar_id) + "/events",
        "POST",
        args.data,
        operation,
      ),
  ),
  tool(
    "calendar.update_event",
    () => t("mcp.tool.calendarUpdate"),
    schema({ calendar_id: field, event_id: field, version: number, data }, [
      "calendar_id",
      "event_id",
      "version",
      "data",
    ]),
    "calendar.write",
    "calendar.events.update",
    "external",
    (env, principal, args, operation) =>
      domainRequest(
        env,
        principal,
        "/api/calendar/calendars/" + path(args.calendar_id) + "/events/" + path(args.event_id),
        "PATCH",
        { ...object(args.data), version: args.version },
        operation,
      ),
  ),
  tool(
    "calendar.delete_event",
    () => t("mcp.tool.calendarDelete"),
    schema({ calendar_id: field, event_id: field, version: number }, [
      "calendar_id",
      "event_id",
      "version",
    ]),
    "calendar.write",
    "calendar.events.delete",
    "external",
    (env, principal, args, operation) =>
      domainRequest(
        env,
        principal,
        "/api/calendar/calendars/" +
          path(args.calendar_id) +
          "/events/" +
          path(args.event_id) +
          "?version=" +
          args.version,
        "DELETE",
        undefined,
        operation,
      ),
  ),
];
export const builtinTool = (name: string) => builtin.find((entry) => entry.name === name);
export async function availableTools(env: AIEnv, principal: AIPrincipal) {
  const actor = await identity(env, principal),
    permissions = await permissionsFor(createDatabase(env.DB), actor.user.id);
  const servers = await rows<{ builtin_key: string }>(
    env,
    "SELECT builtin_key FROM ai_mcp_servers WHERE transport='builtin' AND enabled=1",
  );
  return builtin.filter(
    (entry) =>
      permissions.includes(entry.permission as never) &&
      servers.some((server) => server.builtin_key === entry.server),
  );
}
export async function ensureToolRecord(env: AIEnv, definition: ToolDefinition) {
  const server = await first<{ id: string }>(
    env,
    "SELECT id FROM ai_mcp_servers WHERE builtin_key=? AND transport='builtin' AND enabled=1",
    definition.server,
  );
  if (!server) fail(403, "AI_FORBIDDEN");
  const schemaHash = await hash([definition.name, definition.inputSchema, definition.execution]);
  await statement(
    env,
    "INSERT INTO ai_mcp_tools(id,server_id,name,revision,description,input_schema_json,schema_hash,execution_class,approval_policy,replay_policy,enabled) VALUES(?,?,?,1,?,?,?,?,?,?,1) ON CONFLICT(server_id,name,revision) DO NOTHING",
    definition.id,
    server.id,
    definition.name,
    definition.description,
    canonical(definition.inputSchema),
    schemaHash,
    definition.execution,
    definition.execution === "read" ? "none" : "always",
    definition.replay,
  ).run();
  return { serverId: server.id, toolId: definition.id, schemaHash };
}
export async function toolIntent(
  env: AIEnv,
  principal: AIPrincipal,
  definition: ToolDefinition,
  args: ObjectValue,
) {
  validateSchema(definition.inputSchema, args);
  const actor = await identity(env, principal);
  const permissions = await permissionsFor(createDatabase(env.DB), actor.user.id);
  if (!permissions.includes(definition.permission as never)) fail(403, "AI_FORBIDDEN");
  const record = await ensureToolRecord(env, definition);
  let revision: unknown = null;
  if (args.contact_id)
    revision = object(
      await domainRequest(env, principal, "/api/contacts/" + path(args.contact_id)),
    ).contact;
  else if (args.item_id)
    revision = object(
      await domainRequest(env, principal, "/api/drive/items/" + path(args.item_id)),
    ).item;
  else if (args.event_id)
    revision = object(
      await domainRequest(
        env,
        principal,
        "/api/calendar/calendars/" + path(args.calendar_id) + "/events/" + path(args.event_id),
      ),
    ).event;
  else if (args.draft_id && args.mailbox_id)
    revision = await executeMailTool(
      env,
      { user_id: actor.user.id, auth_version: actor.user.auth_version, api_key_id: null },
      "request_send",
      args,
    );
  const version =
    revision && typeof revision === "object" ? (revision as Record<string, unknown>).version : null;
  if (args.version !== undefined && version !== null && args.version !== version)
    fail(409, "AI_APPROVAL_STALE");
  return {
    ...record,
    args_hash: await hash(args),
    resource_version: version,
    snapshot_hash: await hash([definition.name, schemaHashOf(record), args, version]),
  };
}
const schemaHashOf = (record: { schemaHash: string }) => record.schemaHash;
export async function runBuiltinTool(
  env: AIEnv,
  principal: AIPrincipal,
  name: string,
  args: ObjectValue,
  operation: string,
) {
  const definition = builtinTool(name);
  if (!definition) fail(404, "AI_NOT_FOUND");
  await toolIntent(env, principal, definition, args);
  return definition.run(env, principal, args, operation);
}
