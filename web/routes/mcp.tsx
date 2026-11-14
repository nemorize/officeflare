import { useEffect, useState } from "react";
import { Navigate, useLocation, useParams } from "react-router";
import { Button } from "../components/ui";
import { api, errorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import { t } from "../../shared/i18n/index.ts";

const labels = () => ({
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
export default function MCPPage() {
  const auth = useSession(),
    location = useLocation(),
    params = useParams();
  const requestId = new URLSearchParams(location.search).get("request"),
    operationId = params.id;
  const [request, setRequest] = useState<{
    id: string;
    client_name: string;
    redirect_uri: string;
    scopes: string[];
  } | null>(null);
  const [operation, setOperation] = useState<{
    operation_id: string;
    tool_name: string;
    arguments: Record<string, unknown>;
    intent_hash: string;
    status: string;
  } | null>(null);
  const [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const connected = location.pathname === "/mcp/connected";
  useEffect(() => {
    if (!auth.session || connected) return;
    let active = true;
    const load = async () => {
      try {
        if (operationId) {
          const result = await api<{ operation: NonNullable<typeof operation> }>(
            `/api/mcp/operations/${encodeURIComponent(operationId)}`,
          );
          if (active) setOperation(result.operation);
        } else if (requestId) {
          const result = await api<{ request: NonNullable<typeof request> }>(
            `/api/mcp/oauth/requests/${encodeURIComponent(requestId)}`,
          );
          if (active) {
            setRequest(result.request);
            setSelected(result.request.scopes);
          }
        } else throw new Error(t("ai.invalid"));
      } catch (failure) {
        if (active) setError(errorMessage(failure));
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [auth.session, operationId, requestId, connected]);
  if (auth.status === "signed_out")
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  async function decide(decision: "allow" | "deny") {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (operation) {
        const result = await api<{ status: string }>(
          `/api/mcp/operations/${encodeURIComponent(operation.operation_id)}/decision`,
          { method: "POST", body: { decision, intent_hash: operation.intent_hash } },
        );
        setOperation({ ...operation, status: result.status });
      } else if (request) {
        const result = await api<{ redirect_uri: string }>(
          `/api/mcp/oauth/requests/${encodeURIComponent(request.id)}/decision`,
          { method: "POST", body: { decision, scopes: selected } },
        );
        window.location.assign(result.redirect_uri);
      }
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  const statuses = {
    pending: t("mcp.pending"),
    approved: t("mcp.approved"),
    executing: t("mcp.executing"),
    succeeded: t("mcp.completed"),
    denied: t("mcp.denied"),
    failed: t("mcp.failed"),
    unknown: t("ai.unknown"),
    expired: t("mcp.expired"),
  };
  return (
    <main className="login-page">
      <div className="login-content">
        <section className="login-card" aria-busy={busy}>
          <h1>{operationId ? t("mcp.reviewTitle") : t("mcp.authorizeTitle")}</h1>
          {error && <p role="alert">{error}</p>}
          {connected ? (
            <p>
              {new URLSearchParams(location.search).get("status") === "connected"
                ? t("mcp.connected")
                : t("mcp.failed")}
            </p>
          ) : operation ? (
            <>
              <p>{operation.tool_name}</p>
              <dl>
                {Object.entries(operation.arguments).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
                    </dd>
                  </div>
                ))}
              </dl>
              <p role="status">
                {statuses[operation.status as keyof typeof statuses] ?? t("mcp.pending")}
              </p>
              {operation.status === "pending" && (
                <div className="form-actions">
                  <Button disabled={busy} onClick={() => void decide("deny")}>
                    {t("mcp.deny")}
                  </Button>
                  <Button disabled={busy} onClick={() => void decide("allow")}>
                    {t("mcp.approveOperation")}
                  </Button>
                </div>
              )}
            </>
          ) : request ? (
            <>
              <h2>{request.client_name}</h2>
              <p>{new URL(request.redirect_uri).origin}</p>
              <p>{t("mcp.authorizeDescription")}</p>
              <fieldset disabled={busy}>
                <legend>{t("mcp.permissions")}</legend>
                {request.scopes.map((scope) => (
                  <label key={scope} style={{ display: "flex", gap: 8, paddingBlock: 6 }}>
                    <input
                      type="checkbox"
                      checked={selected.includes(scope)}
                      onChange={(event) =>
                        setSelected((values) =>
                          event.target.checked
                            ? [...values, scope]
                            : values.filter((value) => value !== scope),
                        )
                      }
                    />
                    {labels()[scope as keyof ReturnType<typeof labels>] ?? scope}
                  </label>
                ))}
              </fieldset>
              <div className="form-actions">
                <Button disabled={busy} onClick={() => void decide("deny")}>
                  {t("mcp.deny")}
                </Button>
                <Button disabled={busy || !selected.length} onClick={() => void decide("allow")}>
                  {t("mcp.allow")}
                </Button>
              </div>
            </>
          ) : (
            !error && <p role="status">{t("mcp.loading")}</p>
          )}
        </section>
      </div>
    </main>
  );
}
