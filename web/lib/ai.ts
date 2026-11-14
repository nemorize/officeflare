import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "./api";
import { useSession } from "./session";
import { t } from "../../shared/i18n/index.ts";

export interface AIRoom {
  id: string;
  title: string;
  profile_id: string;
  profile_key?: string;
  instructions?: string | null;
  version: number;
  created_at: number;
  updated_at: number;
}
export interface AIProfile {
  id: string;
  key: string;
  name: string;
}
export interface AIRun {
  id: string;
  room_id: string;
  status: string;
  error_code: string | null;
  created_at: number;
  deadline_at: number;
}
export interface AIMessage {
  id: string;
  seq: number;
  role: string;
  content: string | null;
  status: string;
  version: number;
  tool_calls?: { id: string; name: string; arguments: Record<string, unknown> }[];
}
export interface AIApproval {
  id: string;
  status: string;
  tool_name: string;
  intent_hash: string;
  arguments: Record<string, unknown>;
  expires_at: number;
}
export interface AIConnection {
  id: string;
  server_id: string;
  name: string;
  status: string;
  version: number;
}
export interface AITool {
  name: string;
  description: string;
  execution: string;
}
export interface AIBinding {
  connection_id: string;
  allowed_tools: string[];
}
export interface AIServer {
  id: string;
  name: string;
  transport: string;
  builtin_key: string | null;
}
export interface AIQuotaRule {
  metric: string;
  window_kind: string;
  scope_key: string;
  limit_value: number | null;
}
export interface AIQuotaBucket {
  metric: string;
  window_kind: string;
  scope_key: string;
  used_amount: number;
  reserved_amount: number;
  window_end: number;
}
export type AIRecord = Record<string, unknown> & {
  id: string;
  name?: string;
  key?: string;
  version: number;
  enabled?: number;
  status?: string;
};
export const aiAdminPermissions = ["settings", "providers", "quotas", "usage", "audit"].map(
  (group) => `admin.ai.${group}.read`,
);
export const activeRun = (run: AIRun | null | undefined) =>
  !!run &&
  ["queued", "running", "waiting_approval", "reconciling", "cancel_requested"].includes(run.status);
export const busyRun = (run: AIRun | null | undefined) =>
  !!run && ["queued", "running", "cancel_requested"].includes(run.status);
export const aiStatus = (status: string) => {
  const labels: Record<string, string> = {
    queued: t("aiui.queued"),
    running: t("mcp.executing"),
    waiting_approval: t("mcp.pending"),
    reconciling: t("aiui.reconciling"),
    succeeded: t("mcp.completed"),
    failed: t("aiui.failed"),
    cancelled: t("aiui.cancelled"),
    cancel_requested: t("aiui.cancelling"),
    active: t("aiui.active"),
    disabled: t("aiui.disabled"),
    connected: t("aiui.connected"),
    reauth_required: t("aiui.reauth"),
    revoked: t("aiui.revoked"),
    unknown: t("aiui.reconciling"),
  };
  return labels[status] ?? status;
};
export const aiMetric = (metric: string) => {
  const labels: Record<string, string> = {
    invocations: t("aiui.requests"),
    chat_runs: t("aiui.runs"),
    input_tokens: t("aiui.inputTokens"),
    output_tokens: t("aiui.outputTokens"),
    total_tokens: t("aiui.totalTokens"),
    cost_micro_usd: t("aiui.cost"),
    tool_calls: t("aiui.toolCalls"),
    concurrent_invocations: t("aiui.concurrentRequests"),
    concurrent_runs: t("aiui.concurrentRuns"),
  };
  return labels[metric] ?? metric;
};
export const aiWindow = (window: string) =>
  ({
    minute: t("aiui.minute"),
    day: t("aiui.day"),
    month: t("aiui.month"),
    lifetime: t("aiui.lifetime"),
    concurrent: t("aiui.concurrent"),
  })[window as "day"] ?? window;
export const aiMoney = (value: unknown) =>
  value === null || value === undefined
    ? t("aiui.unpriced")
    : new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 6,
      }).format(Number(value) / 1_000_000);
export function jsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  return typeof value === "string" ? JSON.parse(value) : (value as Record<string, unknown>);
}

export function useAIResource<T>(path: string | null, interval = 0) {
  const sessionId = useSession().session?.tokens.session_id;
  const [revision, setRevision] = useState(0),
    [state, setState] = useState<{ key: string; data: T | null; loading: boolean; error: string }>({
      key: "",
      data: null,
      loading: !!path,
      error: "",
    });
  const key = `${sessionId}:${path}`;
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!path || !sessionId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setState((old) => ({
      key,
      data: old.key === key ? old.data : null,
      loading: old.key !== key || !old.data,
      error: "",
    }));
    const load = async () => {
      try {
        const data = await api<T>(path, { signal: controller.signal });
        if (!controller.signal.aborted) setState({ key, data, loading: false, error: "" });
      } catch (failure) {
        if (!controller.signal.aborted)
          setState((old) => ({ ...old, key, loading: false, error: errorMessage(failure) }));
      } finally {
        if (interval && !controller.signal.aborted) timer = setTimeout(load, interval);
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [path, key, interval, revision, sessionId]);
  const current =
    path && state.key === key ? state : { key, data: null, loading: !!path, error: "" };
  return {
    ...current,
    reload,
    update: (data: T) => setState({ key, data, loading: false, error: "" }),
  };
}
