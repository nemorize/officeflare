import { createContext, useContext, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router";
import { useState } from "react";
import { useAccess } from "./console-access";
import { Button, Icon, Input } from "./ui";
import { useAIResource, type AIProfile, type AIRoom } from "../lib/ai";
import { t } from "../../shared/i18n/index.ts";
import "../routes/ai.css";

interface AIContextValue {
  rooms: AIRoom[];
  profiles: AIProfile[];
  enabled: boolean;
  loading: boolean;
  error: string;
  refresh: () => void;
}
const AIContext = createContext<AIContextValue>({
  rooms: [],
  profiles: [],
  enabled: false,
  loading: false,
  error: "",
  refresh: () => {},
});
export const useAI = () => useContext(AIContext);
export function AIProvider({ children }: { children: ReactNode }) {
  const location = useLocation(),
    access = useAccess();
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
export function AISidebar() {
  const ai = useAI(),
    { permissions } = useAccess(),
    [query, setQuery] = useState("");
  return (
    <>
      <div className="workspace-create-action">
        <Button
          className="workspace-create-button"
          render={<NavLink to="/ai" />}
          disabled={!permissions.includes("ai.runs.create")}
        >
          <Icon name="plus" />
          <span>{t("aiui.newChat")}</span>
        </Button>
      </div>
      <div className="ai-sidebar-search">
        <Icon name="search" />
        <Input
          variant="integrated"
          aria-label={t("aiui.searchChats")}
          placeholder={t("aiui.searchChats")}
          value={query}
          onValueChange={setQuery}
        />
      </div>
      <nav className="workspace-nav ai-room-nav" aria-label={t("aiui.conversations")}>
        <h2>{t("aiui.conversations")}</h2>
        {ai.rooms
          .filter((room) => room.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
          .map((room) => (
            <NavLink to={`/ai/rooms/${room.id}`} key={room.id}>
              <Icon name="message" />
              <span>{room.title}</span>
            </NavLink>
          ))}
        {!ai.loading && !ai.rooms.length && <p className="ai-sidebar-empty">{t("aiui.noChats")}</p>}
      </nav>
      <nav className="workspace-nav ai-sidebar-footer" aria-label={t("common.settings")}>
        {permissions.includes("ai.connections.manage") && (
          <NavLink to="/ai/connections">
            <Icon name="link" />
            <span>{t("aiui.connections")}</span>
          </NavLink>
        )}
        <NavLink to="/ai/usage">
          <Icon name="layers" />
          <span>{t("aiui.usage")}</span>
        </NavLink>
      </nav>
    </>
  );
}
