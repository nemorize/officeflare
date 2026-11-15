import { createContext, useContext, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router";
import { useState } from "react";
import { useAccess } from "./console-access";
import { Icon } from "./ui";
import { WorkspaceCreateButton } from "./workspace-controls";
import { useAIResource, type AIProfile, type AIRoom } from "../lib/ai";
import { t } from "../../shared/i18n/index.ts";
import "../routes/ai.css";

interface AIContextValue {
  rooms: AIRoom[];
  profiles: AIProfile[];
  enabled: boolean;
  loading: boolean;
  error: string;
  query: string;
  setQuery: (query: string) => void;
  refresh: () => void;
}
const AIContext = createContext<AIContextValue>({
  rooms: [],
  profiles: [],
  enabled: false,
  loading: false,
  error: "",
  query: "",
  setQuery: () => {},
  refresh: () => {},
});
export const useAI = () => useContext(AIContext);
export function AIProvider({ children }: { children: ReactNode }) {
  const location = useLocation(),
    access = useAccess();
  const [query, setQuery] = useState("");
  const enabled =
    /^\/ai(?:\/|$)/.test(location.pathname) && access.permissions.includes("ai.access");
  const rooms = useAIResource<{ rooms: AIRoom[] }>(enabled ? "/api/ai/rooms" : null);
  const profiles = useAIResource<{ profiles: AIProfile[] }>(enabled ? "/api/ai/models" : null);
  const capabilities = useAIResource<{ enabled: boolean }>(enabled ? "/api/ai/capabilities" : null);
  return (
    <AIContext
      value={{
        rooms: rooms.data?.rooms ?? [],
        profiles: profiles.data?.profiles ?? [],
        enabled: capabilities.data?.enabled ?? false,
        loading: rooms.loading || profiles.loading || capabilities.loading,
        error: rooms.error || profiles.error || capabilities.error,
        query,
        setQuery,
        refresh: () => {
          rooms.reload();
          profiles.reload();
          capabilities.reload();
        },
      }}
    >
      {children}
    </AIContext>
  );
}
export function AISidebar({ onNavigate }: { onNavigate?: () => void }) {
  const ai = useAI(),
    { permissions } = useAccess();
  const rooms = ai.rooms.filter((room) =>
    room.title.toLocaleLowerCase().includes(ai.query.trim().toLocaleLowerCase()),
  );
  function navigate() {
    ai.setQuery("");
    onNavigate?.();
  }
  return (
    <div className="ai-sidebar-body">
      <div className="workspace-create-action">
        <WorkspaceCreateButton
          label={t("aiui.newChat")}
          nativeButton={false}
          render={<NavLink to="/ai" />}
          onClick={navigate}
          disabled={!permissions.includes("ai.runs.create")}
        />
      </div>
      <nav className="workspace-nav ai-room-nav" aria-label={t("aiui.conversations")}>
        <h2>{t("aiui.conversations")}</h2>
        {rooms.map((room) => (
          <NavLink to={`/ai/rooms/${room.id}`} key={room.id} onClick={navigate}>
            <Icon name="message" />
            <span>{room.title}</span>
          </NavLink>
        ))}
        {!ai.loading && !rooms.length && (
          <p className="ai-sidebar-empty">
            {t(ai.query.trim() ? "aiui.noSearchResults" : "aiui.noChats")}
          </p>
        )}
      </nav>
      <nav className="workspace-nav ai-sidebar-footer" aria-label={t("common.settings")}>
        {permissions.includes("ai.connections.manage") && (
          <NavLink to="/ai/connections" onClick={navigate}>
            <Icon name="link" />
            <span>{t("aiui.connections")}</span>
          </NavLink>
        )}
        <NavLink to="/ai/usage" onClick={navigate}>
          <Icon name="layers" />
          <span>{t("aiui.usage")}</span>
        </NavLink>
      </nav>
    </div>
  );
}
