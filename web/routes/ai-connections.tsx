import { useState, type FormEvent } from "react";
import { t } from "../../shared/i18n/index.ts";
import { api, errorMessage } from "../lib/api";
import { aiStatus, useAIResource, type AIConnection, type AIServer } from "../lib/ai";
import { useAccess } from "../components/console-access";
import { Button, Icon } from "../components/ui";
import { Check, Confirm, Notice, adminDate } from "../components/console-shared";
import {
  ConsoleDialog,
  ConsoleField,
  ConsoleFormActions,
  ConsoleInput,
  ConsoleSelectField,
  ConsoleState,
  ConsoleSection,
  ConsoleSettingsHeader,
} from "../components/console-settings";

const scopeLabels = () => ({
  "mail.read": t("mcp.mailRead"),
  "mail.write": t("mcp.mailWrite"),
  "mail.send": t("mcp.mailSend"),
  "contacts.read": t("mcp.contactsRead"),
  "contacts.write": t("mcp.contactsWrite"),
  "drive.read": t("mcp.driveRead"),
  "drive.write": t("mcp.driveWrite"),
  "calendar.read": t("mcp.calendarRead"),
  "calendar.write": t("mcp.calendarWrite"),
});
interface Grant {
  id: string;
  client_name: string;
  scopes_json: string;
  revoked_at: number | null;
  expires_at: number;
}
interface APIKey {
  id: string;
  name: string;
  scopes_json: string;
  expires_at: number;
  revoked_at: number | null;
}
interface Account {
  id: string;
  name: string;
  provider_name: string;
  status: string;
  version: number;
}
export function AIConnectionsPage() {
  const { permissions } = useAccess(),
    canManage = permissions.includes("ai.connections.manage");
  const connections = useAIResource<{ connections: AIConnection[] }>(
    canManage ? "/api/ai/mcp/connections" : null,
  );
  const servers = useAIResource<{ servers: (AIServer & { oauth: number })[] }>(
    canManage ? "/api/ai/mcp/servers" : null,
  );
  const providers = useAIResource<{ providers: { id: string; name: string }[] }>(
    canManage ? "/api/ai/providers" : null,
  );
  const accounts = useAIResource<{ accounts: Account[] }>(canManage ? "/api/ai/accounts" : null);
  const grants = useAIResource<{ grants: Grant[] }>("/api/mcp/grants"),
    keys = useAIResource<{ keys: APIKey[] }>("/api/mcp/api-keys");
  const [mode, setMode] = useState<"tool" | "account" | "key" | null>(null),
    [name, setName] = useState(""),
    [selected, setSelected] = useState(""),
    [secret, setSecret] = useState(""),
    [scopes, setScopes] = useState<string[]>([]),
    [days, setDays] = useState("30");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [dialogError, setDialogError] = useState(""),
    [issuedKey, setIssuedKey] = useState("");
  const [remove, setRemove] = useState<{ path: string; name: string } | null>(null);
  const [toolList, setToolList] = useState<{
    name: string;
    tools: { name: string; description: string }[];
  } | null>(null);
  const [inspecting, setInspecting] = useState<string | null>(null);
  function refresh() {
    connections.reload();
    accounts.reload();
    grants.reload();
    keys.reload();
  }
  function open(next: typeof mode) {
    setMode(next);
    setName("");
    setSelected("");
    setSecret("");
    setScopes([]);
    setDays("30");
    setDialogError("");
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setDialogError("");
    try {
      if (mode === "tool") {
        const server = servers.data?.servers.find((item) => item.id === selected);
        const result = await api<{ connection: AIConnection }>("/api/ai/mcp/connections", {
          method: "POST",
          body: {
            server_id: selected,
            name,
            ...(server?.transport !== "builtin" && secret ? { secret: { api_key: secret } } : {}),
          },
        });
        if (server?.oauth && !secret) {
          const oauth = await api<{ authorization_url: string }>(
            `/api/ai/mcp/connections/${result.connection.id}/oauth/start`,
            { method: "POST", body: {} },
          );
          window.location.assign(oauth.authorization_url);
        }
      } else if (mode === "account") {
        const result = await api<{ account: Account }>("/api/ai/accounts", {
          method: "POST",
          body: { provider_id: selected, name },
        });
        const oauth = await api<{ authorization_url: string }>(
          `/api/ai/accounts/${result.account.id}/oauth/start`,
          { method: "POST", body: {} },
        );
        window.location.assign(oauth.authorization_url);
      } else {
        const result = await api<{ key: { token: string } }>("/api/mcp/api-keys", {
          method: "POST",
          body: { name, scopes, expires_at: Math.floor(Date.now() / 1000) + Number(days) * 86400 },
        });
        setIssuedKey(result.key.token);
      }
      setSecret("");
      setMode(null);
      refresh();
    } catch (failure) {
      setDialogError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  async function reconnect(path: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ authorization_url: string }>(path, { method: "POST", body: {} });
      window.location.assign(result.authorization_url);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  const server = servers.data?.servers.find((item) => item.id === selected);
  return (
    <section className="account-page console-page ai-settings-page">
      <ConsoleSettingsHeader title={t("aiui.connections")} description={t("aiui.connectionsHint")}>
        <Button variant="ghost" onClick={refresh}>
          <Icon name="refresh" />
          {t("aiui.refresh")}
        </Button>
      </ConsoleSettingsHeader>
      <Notice
        error={
          error ||
          connections.error ||
          accounts.error ||
          servers.error ||
          providers.error ||
          grants.error ||
          keys.error
        }
      />
      {canManage && (
        <ConsoleSection
          title={t("aiui.toolConnections")}
          description={t("aiui.toolConnectionsHint")}
          action={
            <Button onClick={() => open("tool")}>
              <Icon name="plus" />
              {t("aiui.addConnection")}
            </Button>
          }
        >
          <ConsoleState loading={connections.loading} error={connections.error} />
          {!connections.loading && !connections.data?.connections.length && (
            <p className="ai-empty-inline">{t("aiui.noConnections")}</p>
          )}
          <div className="ai-connection-list">
            {connections.data?.connections
              .filter((connection) => connection.status !== "disabled")
              .map((connection) => (
                <div className="ai-connection-row" key={connection.id}>
                  <span className="ai-connection-icon">
                    <Icon name="code" />
                  </span>
                  <div>
                    <strong>{connection.name}</strong>
                    <small>
                      {
                        servers.data?.servers.find((server) => server.id === connection.server_id)
                          ?.name
                      }{" "}
                      · {aiStatus(connection.status)}
                    </small>
                  </div>
                  <div className="ai-row-actions">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!!inspecting}
                      onClick={async () => {
                        setInspecting(connection.id);
                        setError("");
                        try {
                          const result = await api<{
                            tools: { name: string; description: string }[];
                          }>(`/api/ai/mcp/connections/${connection.id}/tools`);
                          setToolList({ name: connection.name, tools: result.tools });
                        } catch (failure) {
                          setError(errorMessage(failure));
                        } finally {
                          setInspecting(null);
                        }
                      }}
                    >
                      {t("aiui.viewTools")}
                    </Button>
                    {servers.data?.servers.find((server) => server.id === connection.server_id)
                      ?.oauth === 1 && (
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void reconnect(`/api/ai/mcp/connections/${connection.id}/oauth/start`)
                        }
                      >
                        {t("aiui.reconnect")}
                      </Button>
                    )}
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t("aiui.disconnectNamed", { name: connection.name })}
                      onClick={() =>
                        setRemove({
                          path: `/api/ai/mcp/connections/${connection.id}`,
                          name: connection.name,
                        })
                      }
                    >
                      <Icon name="close" />
                    </Button>
                  </div>
                </div>
              ))}
          </div>
        </ConsoleSection>
      )}
      {canManage && (
        <ConsoleSection
          title={t("aiui.personalAccounts")}
          description={t("aiui.personalAccountsHint")}
          action={
            <Button disabled={!providers.data?.providers.length} onClick={() => open("account")}>
              <Icon name="plus" />
              {t("aiui.connectAccount")}
            </Button>
          }
        >
          {!providers.loading && !providers.data?.providers.length && (
            <p className="ai-empty-inline">{t("aiui.noOAuthProviders")}</p>
          )}
          <div className="ai-connection-list">
            {accounts.data?.accounts
              .filter((account) => account.status !== "revoked")
              .map((account) => (
                <div className="ai-connection-row" key={account.id}>
                  <span className="ai-connection-icon">
                    <Icon name="user" />
                  </span>
                  <div>
                    <strong>{account.name}</strong>
                    <small>
                      {account.provider_name} · {aiStatus(account.status)}
                    </small>
                  </div>
                  <div className="ai-row-actions">
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => void reconnect(`/api/ai/accounts/${account.id}/oauth/start`)}
                    >
                      {t("aiui.reconnect")}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t("aiui.disconnectNamed", { name: account.name })}
                      onClick={() =>
                        setRemove({ path: `/api/ai/accounts/${account.id}`, name: account.name })
                      }
                    >
                      <Icon name="close" />
                    </Button>
                  </div>
                </div>
              ))}
          </div>
        </ConsoleSection>
      )}
      <ConsoleSection title={t("aiui.externalApps")} description={t("aiui.externalAppsHint")}>
        <div className="ai-endpoint">
          <span>{t("aiui.mcpEndpoint")}</span>
          <code>{new URL("/api/mcp", window.location.origin).href}</code>
        </div>
        {!grants.loading && !grants.data?.grants.some((grant) => !grant.revoked_at) && (
          <p className="ai-empty-inline">{t("aiui.noExternalApps")}</p>
        )}
        <div className="ai-connection-list">
          {grants.data?.grants
            .filter((grant) => !grant.revoked_at)
            .map((grant) => (
              <div className="ai-connection-row" key={grant.id}>
                <Icon name="laptop" />
                <div>
                  <strong>{grant.client_name}</strong>
                  <small>
                    {(JSON.parse(grant.scopes_json) as string[])
                      .map(
                        (scope) =>
                          scopeLabels()[scope as keyof ReturnType<typeof scopeLabels>] ?? scope,
                      )
                      .join(" · ")}
                  </small>
                </div>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() =>
                    setRemove({ path: `/api/mcp/grants/${grant.id}`, name: grant.client_name })
                  }
                >
                  {t("aiui.revoke")}
                </Button>
              </div>
            ))}
        </div>
      </ConsoleSection>
      <ConsoleSection
        title={t("aiui.apiKeys")}
        description={t("aiui.apiKeysHint")}
        action={
          <Button onClick={() => open("key")}>
            <Icon name="plus" />
            {t("aiui.createKey")}
          </Button>
        }
      >
        {!keys.loading && !keys.data?.keys.some((key) => !key.revoked_at) && (
          <p className="ai-empty-inline">{t("aiui.noKeys")}</p>
        )}
        <div className="ai-connection-list">
          {keys.data?.keys
            .filter((key) => !key.revoked_at)
            .map((key) => (
              <div className="ai-connection-row" key={key.id}>
                <Icon name="shield" />
                <div>
                  <strong>{key.name}</strong>
                  <small>{t("aiui.expires", { date: adminDate(key.expires_at) })}</small>
                </div>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => setRemove({ path: `/api/mcp/api-keys/${key.id}`, name: key.name })}
                >
                  {t("aiui.revoke")}
                </Button>
              </div>
            ))}
        </div>
      </ConsoleSection>
      <ConsoleDialog
        open={!!mode}
        title={
          mode === "key"
            ? t("aiui.createKey")
            : mode === "account"
              ? t("aiui.connectAccount")
              : t("aiui.addConnection")
        }
        onClose={() => {
          setMode(null);
          setSecret("");
        }}
        busy={busy}
      >
        <form className="ai-settings-form" onSubmit={(event) => void create(event)}>
          <Notice error={dialogError} />
          <ConsoleInput
            label={t("common.name")}
            value={name}
            onValueChange={setName}
            maxLength={100}
            required
          />
          {mode !== "key" && (
            <ConsoleSelectField
              label={mode === "tool" ? t("aiui.server") : t("aiui.provider")}
              value={selected}
              onChange={setSelected}
              options={[
                { value: "", label: t("aiui.choose") },
                ...(mode === "tool"
                  ? (servers.data?.servers ?? [])
                  : (providers.data?.providers ?? [])
                ).map((item) => ({ value: item.id, label: item.name })),
              ]}
            />
          )}
          {mode === "tool" && server?.transport === "streamable_http" && (
            <ConsoleInput
              label={t("aiui.apiKey")}
              hint={t("aiui.optionalKey")}
              type="password"
              autoComplete="off"
              value={secret}
              onValueChange={setSecret}
            />
          )}
          {mode === "key" && (
            <>
              <ConsoleInput
                label={t("aiui.expiresDays")}
                type="number"
                min={1}
                max={365}
                required
                value={days}
                onValueChange={setDays}
              />
              <fieldset className="ai-scope-field">
                <legend>{t("mcp.permissions")}</legend>
                <div className="ai-scope-grid">
                  {Object.entries(scopeLabels()).map(([scope, label]) => (
                    <Check
                      key={scope}
                      checked={scopes.includes(scope)}
                      onChange={(checked) =>
                        setScopes((values) =>
                          checked ? [...values, scope] : values.filter((value) => value !== scope),
                        )
                      }
                    >
                      {label}
                    </Check>
                  ))}
                </div>
                <p className="ai-form-hint">{t("aiui.keyScopesHint")}</p>
              </fieldset>
            </>
          )}
          <ConsoleFormActions>
            <Button
              onClick={() => {
                setMode(null);
                setSecret("");
              }}
              disabled={busy}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={busy || !name.trim() || (mode === "key" ? !scopes.length : !selected)}
            >
              {busy ? t("common.saving") : mode === "key" ? t("aiui.createKey") : t("aiui.connect")}
            </Button>
          </ConsoleFormActions>
        </form>
      </ConsoleDialog>
      <ConsoleDialog
        open={!!issuedKey}
        title={t("aiui.keyCreated")}
        description={t("aiui.keyOnce")}
        onClose={() => setIssuedKey("")}
      >
        <textarea
          className="ai-issued-key"
          aria-label={t("aiui.newKey")}
          readOnly
          value={issuedKey}
          onFocus={(event) => event.currentTarget.select()}
        />
        <ConsoleFormActions>
          <Button onClick={() => setIssuedKey("")}>{t("aiui.savedKey")}</Button>
        </ConsoleFormActions>
      </ConsoleDialog>
      <ConsoleDialog
        open={!!toolList}
        title={toolList?.name ?? t("aiui.tools")}
        onClose={() => setToolList(null)}
      >
        <div className="ai-tool-directory">
          {toolList?.tools.map((tool) => (
            <div key={tool.name}>
              <strong>{tool.name}</strong>
              <p>{tool.description}</p>
            </div>
          ))}
        </div>
      </ConsoleDialog>
      <Confirm
        open={!!remove}
        title={t("aiui.disconnect")}
        description={t("aiui.disconnectHint", { name: remove?.name ?? "" })}
        label={t("aiui.disconnect")}
        destructive
        onClose={() => setRemove(null)}
        onConfirm={async () => {
          if (!remove) return;
          await api(remove.path, { method: "DELETE" });
          setRemove(null);
          refresh();
        }}
      />
    </section>
  );
}
