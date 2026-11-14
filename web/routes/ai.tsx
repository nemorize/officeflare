import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { t } from "../../shared/i18n/index.ts";
import { api, errorMessage } from "../lib/api";
import {
  activeRun,
  aiStatus,
  busyRun,
  useAIResource,
  type AIApproval,
  type AIBinding,
  type AIConnection,
  type AIMessage,
  type AIRoom,
  type AIRun,
  type AITool,
} from "../lib/ai";
import { useAI } from "../components/ai-context";
import { useAccess } from "../components/console-access";
import { Button, Icon } from "../components/ui";
import { Check, Confirm, Notice } from "../components/console-shared";
import {
  ConsoleDialog,
  ConsoleField,
  ConsoleFormActions,
  ConsoleInput,
  ConsoleSelectField,
} from "../components/console-settings";
import { LoadingSkeleton } from "../components/loading-skeleton";

function MessageText({ content }: { content: string }) {
  return (
    <div className="ai-message-text">
      {content.split(/(```[\s\S]*?```)/g).map((block, index) =>
        block.startsWith("```") ? (
          <pre key={index}>
            <code>{block.slice(3, -3).replace(/^[\w+-]*\n/, "")}</code>
          </pre>
        ) : (
          <div key={index}>
            {block
              .split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
              .map((part, i) =>
                part.startsWith("**") ? (
                  <strong key={i}>{part.slice(2, -2)}</strong>
                ) : part.startsWith("`") ? (
                  <code key={i}>{part.slice(1, -1)}</code>
                ) : (
                  part
                ),
              )}
          </div>
        ),
      )}
    </div>
  );
}
function ChatMessage({ message }: { message: AIMessage }) {
  if (message.role === "tool")
    return (
      <details className="ai-tool-result">
        <summary>
          <Icon name="check" />
          {t("aiui.toolResult")}
        </summary>
        <pre>{message.content ?? t("aiui.contentExpired")}</pre>
      </details>
    );
  return (
    <article
      className={`ai-message ai-message-${message.role}`}
      aria-label={message.role === "user" ? t("aiui.you") : t("aiui.assistant")}
    >
      <div className="ai-message-avatar">
        <Icon name={message.role === "user" ? "user" : "sparkles"} />
      </div>
      <div className="ai-message-body">
        <h2>{message.role === "user" ? t("aiui.you") : t("aiui.assistant")}</h2>
        {message.content ? (
          <MessageText content={message.content} />
        ) : message.status === "streaming" ? (
          <span className="ai-thinking" role="status">
            {t("aiui.thinking")}
            <span />
          </span>
        ) : (
          !message.tool_calls?.length && <p className="ai-muted">{t("aiui.contentExpired")}</p>
        )}
        {!!message.tool_calls?.length && (
          <div className="ai-tool-chips">
            {message.tool_calls.map((call) => (
              <span key={call.id}>
                <Icon name="code" />
                {call.name}
              </span>
            ))}
          </div>
        )}
        {message.status === "interrupted" && <small>{t("aiui.interrupted")}</small>}
      </div>
    </article>
  );
}

function RoomSettings({
  room,
  onClose,
  onSaved,
}: {
  room: AIRoom;
  onClose: () => void;
  onSaved: () => void;
}) {
  const ai = useAI(),
    { permissions } = useAccess();
  const canConnect = permissions.includes("ai.connections.manage");
  const [title, setTitle] = useState(room.title),
    [profile, setProfile] = useState(room.profile_key ?? ""),
    [instructions, setInstructions] = useState(room.instructions ?? "");
  const [version, setVersion] = useState(room.version),
    [bindings, setBindings] = useState<AIBinding[]>([]),
    [connections, setConnections] = useState<
      (AIConnection & { tools: AITool[]; error?: string })[]
    >([]);
  const [loading, setLoading] = useState(canConnect),
    [bindingsLoaded, setBindingsLoaded] = useState(!canConnect),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!canConnect) return;
    const controller = new AbortController();
    void Promise.all([
      api<{ version: number; bindings: AIBinding[] }>(`/api/ai/rooms/${room.id}/mcp-bindings`, {
        signal: controller.signal,
      }),
      api<{ connections: AIConnection[] }>("/api/ai/mcp/connections", {
        signal: controller.signal,
      }),
    ])
      .then(async ([bound, available]) => {
        const tools = await Promise.all(
          available.connections
            .filter((connection) => connection.status === "connected")
            .map(async (connection) => {
              try {
                return {
                  ...connection,
                  tools: (
                    await api<{ tools: AITool[] }>(
                      `/api/ai/mcp/connections/${connection.id}/tools`,
                      { signal: controller.signal },
                    )
                  ).tools,
                };
              } catch (failure) {
                return { ...connection, tools: [], error: errorMessage(failure) };
              }
            }),
        );
        if (!controller.signal.aborted) {
          setBindings(bound.bindings);
          setVersion(bound.version);
          setConnections(tools);
          setBindingsLoaded(true);
          setLoading(false);
        }
      })
      .catch((failure) => {
        if (!controller.signal.aborted) {
          setError(errorMessage(failure));
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [room.id, canConnect]);
  function toggle(connectionId: string, name: string, checked: boolean) {
    setBindings((values) => {
      const current =
        values.find((value) => value.connection_id === connectionId)?.allowed_tools ?? [];
      const tools = checked ? [...current, name] : current.filter((tool) => tool !== name);
      return [
        ...values.filter((value) => value.connection_id !== connectionId),
        ...(tools.length ? [{ connection_id: connectionId, allowed_tools: tools }] : []),
      ];
    });
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ room: AIRoom }>(`/api/ai/rooms/${room.id}`, {
        method: "PATCH",
        body: {
          version,
          title,
          ...(profile !== room.profile_key ? { profile_key: profile } : {}),
          ...(instructions !== (room.instructions ?? "") ? { instructions } : {}),
        },
      });
      setVersion(result.room.version);
      if (canConnect)
        await api(`/api/ai/rooms/${room.id}/mcp-bindings`, {
          method: "PUT",
          body: { version: result.room.version, bindings },
        });
      ai.refresh();
      onSaved();
      onClose();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ConsoleDialog open title={t("aiui.chatSettings")} onClose={onClose} busy={busy} wide>
      <form onSubmit={(event) => void save(event)} className="ai-settings-form">
        <Notice error={error} />
        <ConsoleInput
          label={t("aiui.chatTitle")}
          value={title}
          onValueChange={setTitle}
          required
          maxLength={200}
        />
        <ConsoleSelectField
          label={t("aiui.profile")}
          value={profile}
          onChange={setProfile}
          options={ai.profiles.map((item) => ({ value: item.key, label: item.name }))}
        />
        <ConsoleField label={t("aiui.instructions")} hint={t("aiui.instructionsHint")}>
          <textarea
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            maxLength={16000}
            rows={4}
          />
        </ConsoleField>
        {canConnect && (
          <section className="ai-binding-list">
            <h3>{t("aiui.toolsForChat")}</h3>
            <p>{t("aiui.approvalHint")}</p>
            {loading ? (
              <LoadingSkeleton />
            ) : connections.length ? (
              connections.map((connection) => (
                <fieldset key={connection.id}>
                  <legend>{connection.name}</legend>
                  <Notice error={connection.error} />
                  {connection.tools.map((tool) => (
                    <Check
                      key={tool.name}
                      checked={bindings.some(
                        (binding) =>
                          binding.connection_id === connection.id &&
                          binding.allowed_tools.includes(tool.name),
                      )}
                      onChange={(checked) => toggle(connection.id, tool.name, checked)}
                    >
                      <span className="ai-tool-label">
                        <strong>{tool.name}</strong>
                        <small>{tool.description}</small>
                      </span>
                    </Check>
                  ))}
                </fieldset>
              ))
            ) : (
              <Link to="/ai/connections">{t("aiui.addConnection")}</Link>
            )}
          </section>
        )}
        <ConsoleFormActions>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={busy || loading || !bindingsLoaded}>
            {busy ? t("common.saving") : t("common.save")}
          </Button>
        </ConsoleFormActions>
      </form>
    </ConsoleDialog>
  );
}

export function AIChatPage() {
  const { roomId } = useParams(),
    location = useLocation();
  return <ChatSession key={roomId ?? location.key} roomId={roomId} />;
}
function ChatSession({ roomId }: { roomId?: string }) {
  const ai = useAI(),
    navigate = useNavigate(),
    { permissions } = useAccess();
  const location = useLocation();
  const canRun = permissions.includes("ai.runs.create");
  const [draft, setDraft] = useState(""),
    [profile, setProfile] = useState(""),
    [sending, setSending] = useState(false),
    [error, setError] = useState(""),
    [settings, setSettings] = useState(!!location.state?.configureTools),
    [deleting, setDeleting] = useState(false);
  const [messages, setMessages] = useState<AIMessage[]>([]),
    [messageError, setMessageError] = useState("");
  const room = useAIResource<{ room: AIRoom }>(roomId ? `/api/ai/rooms/${roomId}` : null);
  const [poll, setPoll] = useState(0);
  const runs = useAIResource<{ runs: AIRun[] }>(
    roomId ? `/api/ai/rooms/${roomId}/runs` : null,
    poll,
  );
  const run = runs.data?.runs[0] ?? null,
    active = activeRun(run),
    busy = busyRun(run);
  const approvals = useAIResource<{ approvals: AIApproval[] }>(
    run?.status === "waiting_approval" ? `/api/ai/runs/${run.id}/approvals` : null,
    1500,
  );
  const [decisionBusy, setDecisionBusy] = useState(false),
    [messageRevision, setMessageRevision] = useState(0);
  const messagesRef = useRef<AIMessage[]>([]),
    scroll = useRef<HTMLDivElement>(null),
    nearBottom = useRef(true),
    lastActive = useRef(false);
  const request = useRef<{ content: string; room?: string; profile: string; key: string } | null>(
    null,
  );
  const [createdRoom, setCreatedRoom] = useState<string>();
  useEffect(() => {
    setPoll(active ? 1200 : 0);
    if (lastActive.current && !active) {
      room.reload();
      ai.refresh();
    }
    lastActive.current = active;
  }, [active]);
  useEffect(() => {
    if (!roomId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        let after = Math.max(0, (messagesRef.current.at(-1)?.seq ?? 0) - 4);
        const merged = new Map(messagesRef.current.map((message) => [message.id, message]));
        for (;;) {
          const result = await api<{ messages: AIMessage[]; next_seq: number }>(
            `/api/ai/rooms/${roomId}/messages?after=${after}`,
            { signal: controller.signal },
          );
          for (const message of result.messages) merged.set(message.id, message);
          if (result.messages.length < 100 || result.next_seq <= after) break;
          after = result.next_seq;
        }
        if (!controller.signal.aborted) {
          messagesRef.current = [...merged.values()].sort((a, b) => a.seq - b.seq);
          setMessages(messagesRef.current);
          setMessageError("");
        }
      } catch (failure) {
        if (!controller.signal.aborted) setMessageError(errorMessage(failure));
      } finally {
        if (active && !controller.signal.aborted) timer = setTimeout(load, 1200);
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [roomId, active, messageRevision]);
  useEffect(() => {
    if (nearBottom.current)
      scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "instant" });
  }, [messages, approvals.data]);
  useEffect(() => {
    const refresh = () => {
      runs.reload();
      room.reload();
      setMessageRevision((value) => value + 1);
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [runs.reload, room.reload]);
  useEffect(() => {
    if (location.state?.configureTools) navigate(location.pathname, { replace: true, state: null });
  }, [location.state, location.pathname, navigate]);
  async function configureTools() {
    if (active || sending) return;
    setSending(true);
    setError("");
    try {
      if (roomId) {
        const result = await api<{ room: AIRoom }>(`/api/ai/rooms/${roomId}`);
        room.update(result);
        setSettings(true);
      } else {
        const result = await api<{ room: AIRoom }>("/api/ai/rooms", {
          method: "POST",
          body: { title: t("ai.newConversation"), profile_key: profile || ai.profiles[0]?.key },
        });
        ai.refresh();
        navigate(`/ai/rooms/${result.room.id}`, { state: { configureTools: true } });
      }
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setSending(false);
    }
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sending || active || !canRun) return;
    setSending(true);
    setError("");
    const selectedProfile = profile || ai.profiles[0]?.key || "";
    try {
      let target = roomId ?? createdRoom;
      if (!target) {
        const result = await api<{ room: AIRoom }>("/api/ai/rooms", {
          method: "POST",
          body: { title: content.slice(0, 100), profile_key: selectedProfile },
        });
        target = result.room.id;
        setCreatedRoom(target);
        ai.refresh();
      }
      if (
        !request.current ||
        request.current.content !== content ||
        request.current.room !== target ||
        request.current.profile !== selectedProfile
      )
        request.current = {
          content,
          room: target,
          profile: selectedProfile,
          key: crypto.randomUUID(),
        };
      const result = await api<{ run: AIRun }>(`/api/ai/rooms/${target}/runs`, {
        method: "POST",
        headers: { "Idempotency-Key": request.current.key },
        body: { message: content },
      });
      request.current = null;
      setDraft("");
      ai.refresh();
      if (!roomId) navigate(`/ai/rooms/${target}`);
      else {
        runs.update({ runs: [result.run, ...(runs.data?.runs ?? [])] });
        setMessageRevision((value) => value + 1);
        room.reload();
      }
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setSending(false);
    }
  }
  async function action(kind: "cancel" | "resume") {
    if (!run || decisionBusy) return;
    setDecisionBusy(true);
    setError("");
    try {
      const result = await api<{ run: AIRun }>(`/api/ai/runs/${run.id}/${kind}`, {
        method: "POST",
        body: {},
      });
      runs.update({ runs: [result.run, ...(runs.data?.runs.slice(1) ?? [])] });
      setMessageRevision((value) => value + 1);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setDecisionBusy(false);
    }
  }
  async function decide(approval: AIApproval, decision: "allow" | "deny") {
    setDecisionBusy(true);
    setError("");
    try {
      await api(`/api/ai/approvals/${approval.id}/decision`, {
        method: "POST",
        body: { decision, intent_hash: approval.intent_hash },
      });
      approvals.reload();
      runs.reload();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setDecisionBusy(false);
    }
  }
  const unavailable = !ai.enabled || (!roomId && !ai.profiles.length);
  return (
    <section className="ai-chat" aria-label={t("aiui.title")}>
      <div className="ai-chat-toolbar">
        <div>
          <Icon name="sparkles" />
          <strong>{room.data?.room.title ?? t("aiui.newChat")}</strong>
          <span>
            {room.data?.room.profile_key
              ? (ai.profiles.find((item) => item.key === room.data?.room.profile_key)?.name ??
                room.data.room.profile_key)
              : t("aiui.privateChat")}
          </span>
        </div>
        {roomId && (
          <div>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("aiui.chatSettings")}
              disabled={active || !room.data}
              onClick={() => void configureTools()}
            >
              <Icon name="settings" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("aiui.deleteChat")}
              onClick={() => setDeleting(true)}
            >
              <Icon name="trash" />
            </Button>
          </div>
        )}
      </div>
      <div
        className="ai-chat-scroll"
        ref={scroll}
        onScroll={() => {
          const element = scroll.current;
          if (element)
            nearBottom.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 120;
        }}
      >
        {!roomId ? (
          <div className="ai-welcome">
            <span className="ai-welcome-mark">
              <Icon name="sparkles" width={28} height={28} />
            </span>
            <p className="ai-eyebrow">{t("aiui.title")}</p>
            <h1>{t("aiui.welcome")}</h1>
            <p>{t("aiui.welcomeHint")}</p>
            <div className="ai-suggestions">
              {[t("aiui.suggestMail"), t("aiui.suggestContacts"), t("aiui.suggestCalendar")].map(
                (suggestion) => (
                  <button key={suggestion} onClick={() => setDraft(suggestion)}>
                    <Icon name="arrow" />
                    {suggestion}
                  </button>
                ),
              )}
            </div>
          </div>
        ) : (
          <div className="ai-transcript">
            {room.loading && <LoadingSkeleton kind="list" rows={3} />}
            {messages.map((message) => (
              <ChatMessage key={message.id} message={message} />
            ))}
            {run && (
              <div className="ai-run-state" data-state={run.status} role="status">
                <span className={busy ? "ai-status-dot" : ""} />
                {aiStatus(run.status)}
                {run.status === "reconciling" && <p>{t("aiui.reconcilingHint")}</p>}
                {run.status === "failed" && (
                  <>
                    <p>{t("aiui.taskFailedHint")}</p>
                    {canRun && (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={decisionBusy}
                        onClick={() => void action("resume")}
                      >
                        {t("aiui.resume")}
                      </Button>
                    )}
                  </>
                )}
              </div>
            )}
            {approvals.data?.approvals
              .filter((approval) => approval.status === "pending")
              .map((approval) => (
                <section className="ai-approval" key={approval.id}>
                  <div className="ai-approval-heading">
                    <Icon name="shield" />
                    <strong>{t("aiui.approvalNeeded")}</strong>
                  </div>
                  <p>{t("aiui.reviewBeforeRun")}</p>
                  <h3>{approval.tool_name}</h3>
                  <pre>{JSON.stringify(approval.arguments, null, 2)}</pre>
                  <div>
                    <Button
                      variant="secondary"
                      disabled={decisionBusy || !canRun}
                      onClick={() => void decide(approval, "deny")}
                    >
                      {t("mcp.deny")}
                    </Button>
                    <Button
                      disabled={decisionBusy || !canRun}
                      onClick={() => void decide(approval, "allow")}
                    >
                      {t("mcp.approveOperation")}
                    </Button>
                  </div>
                </section>
              ))}
          </div>
        )}
        <div className="ai-chat-errors">
          <Notice error={room.error || runs.error || messageError || approvals.error} />
          {messageError && (
            <Button variant="ghost" onClick={() => setMessageRevision((value) => value + 1)}>
              {t("aiui.refresh")}
            </Button>
          )}
        </div>
      </div>
      <div className="ai-composer-wrap">
        <Notice error={error || ai.error} />
        {unavailable && !ai.loading && (
          <p className="ai-setup-notice">
            <Icon name="info" />
            {t("aiui.notConfigured")}
            {permissions.includes("admin.ai.settings.read") && (
              <Link to="/console/ai">{t("aiui.openConsole")}</Link>
            )}
          </p>
        )}
        <form className="ai-composer" onSubmit={(event) => void send(event)}>
          <textarea
            aria-label={t("aiui.message")}
            placeholder={canRun ? t("aiui.messagePlaceholder") : t("aiui.readOnly")}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={64000}
            rows={3}
            disabled={sending || active || !canRun || unavailable}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                !event.repeat
              ) {
                event.preventDefault();
                if (draft.trim() && !sending && !active && !unavailable)
                  event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="ai-composer-actions">
            <div>
              {!roomId && (
                <select
                  aria-label={t("aiui.profile")}
                  value={profile || ai.profiles[0]?.key || ""}
                  disabled={sending}
                  onChange={(event) => {
                    setProfile(event.target.value);
                    setCreatedRoom(undefined);
                  }}
                >
                  {ai.profiles.map((item) => (
                    <option key={item.id} value={item.key}>
                      {item.name}
                    </option>
                  ))}
                </select>
              )}
              {permissions.includes("ai.connections.manage") && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={active || sending || unavailable}
                  onClick={() => void configureTools()}
                >
                  <Icon name="link" />
                  {t("aiui.tools")}
                </Button>
              )}
            </div>
            {busy ? (
              <Button
                variant="secondary"
                disabled={decisionBusy}
                onClick={() => void action("cancel")}
              >
                <Icon name="stop" />
                {t("aiui.stop")}
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon"
                aria-label={t("aiui.send")}
                disabled={sending || active || unavailable || !canRun || !draft.trim()}
              >
                <Icon name="arrow" />
              </Button>
            )}
          </div>
        </form>
        <p className="ai-composer-note">{t("aiui.composerHint")}</p>
      </div>
      {settings && room.data && (
        <RoomSettings
          room={room.data.room}
          onClose={() => setSettings(false)}
          onSaved={room.reload}
        />
      )}
      <Confirm
        open={deleting}
        title={t("aiui.deleteChat")}
        description={t("aiui.deleteChatHint")}
        label={t("aiui.deleteChat")}
        destructive
        onClose={() => setDeleting(false)}
        onConfirm={async () => {
          await api(`/api/ai/rooms/${roomId}`, { method: "DELETE" });
          ai.refresh();
          navigate("/ai");
        }}
      />
    </section>
  );
}
