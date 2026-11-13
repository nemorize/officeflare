import { t } from "../../shared/i18n/index.ts";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router";
import type { WikiPage, WikiSpace } from "../../shared/wiki";
import { api, errorMessage } from "../lib/api";
import { useAccess } from "./console-access";
interface WikiContextValue {
  spaces: WikiSpace[];
  space: WikiSpace | null;
  pages: WikiPage[];
  pageId: string | null;
  loading: boolean;
  error: string;
  refresh: () => void;
  updateTitle: (id: string, title: string) => void;
  createPage: (parentId?: string | null) => Promise<void>;
  can: (key: string) => boolean;
}
const Context = createContext<WikiContextValue | null>(null);
export function useWiki() {
  const value = useContext(Context);
  if (!value) throw new Error(t("collaboration.invalid"));
  return value;
}
export function WikiProvider({ children }: { children: ReactNode }) {
  const location = useLocation(),
    navigate = useNavigate(),
    access = useAccess();
  const enabled = location.pathname === "/wiki" || location.pathname.startsWith("/wiki/");
  const parts = location.pathname.split("/").filter(Boolean),
    spaceId = enabled ? parts[1] : undefined,
    pageId = enabled ? (parts[2] ?? null) : null;
  const [spaces, setSpaces] = useState<WikiSpace[]>([]),
    [pages, setPages] = useState<WikiPage[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0);
  const activePage = useRef(pageId);
  activePage.current = pageId;
  const keepActive = (previous: WikiPage[]) =>
    previous.filter((page) => page.id === activePage.current).map((page) => ({ ...page, role: 0 }));
  const loadedSpace = useRef<string | undefined>(undefined);
  const refresh = useCallback(() => setRevision((v) => v + 1), []);
  useEffect(() => {
    if (!enabled || !access.permissions.includes("wiki.access")) return;
    const abort = new AbortController();
    if (loadedSpace.current !== spaceId) {
      setLoading(true);
      setPages([]);
    }
    void (async () => {
      const result = await api<{ spaces: WikiSpace[] }>("/api/wiki/spaces", {
        signal: abort.signal,
      });
      if (abort.signal.aborted) return;
      setSpaces(result.spaces);
      if (!spaceId && result.spaces[0]) {
        navigate(`/wiki/${result.spaces[0].id}`, { replace: true });
        return;
      }
      if (spaceId && !result.spaces.some((s) => s.id === spaceId)) {
        setPages(keepActive);
        setError(t("wiki.revoked"));
        if (!activePage.current) navigate("/wiki", { replace: true });
        return;
      }
      if (spaceId) {
        let cursor: string | null = null;
        const all: WikiPage[] = [];
        do {
          const result: { pages: WikiPage[]; next_cursor: string | null } = await api<{
            pages: WikiPage[];
            next_cursor: string | null;
          }>(
            `/api/wiki/spaces/${spaceId}/pages${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
            { signal: abort.signal },
          );
          all.push(...result.pages);
          cursor = result.next_cursor;
        } while (cursor && !abort.signal.aborted);
        if (abort.signal.aborted) return;
        // Keep an open editor mounted after revocation so unsent edits can be copied.
        setPages((previous) => {
          const local = previous.find((page) => page.id === activePage.current);
          return local && !all.some((page) => page.id === local.id)
            ? [...all, { ...local, role: 0 }]
            : all;
        });
        loadedSpace.current = spaceId;
      }
      setError("");
    })()
      .catch((failure) => {
        if (!abort.signal.aborted) {
          setError(errorMessage(failure));
          if ([403, 404].includes((failure as { status: number }).status)) setPages(keepActive);
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [enabled, spaceId, revision, access.permissions, navigate]);
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 10000);
    const focus = () => refresh();
    window.addEventListener("focus", focus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [enabled, refresh]);
  const createPage = useCallback(
    async (parentId: string | null = null) => {
      if (!spaceId) return;
      const result = await api<{ page: WikiPage }>(`/api/wiki/spaces/${spaceId}/pages`, {
        method: "POST",
        body: { parent_id: parentId },
      });
      setPages((old) => [...old, result.page]);
      navigate(`/wiki/${spaceId}/${result.page.id}`);
      refresh();
    },
    [spaceId, navigate, refresh],
  );
  const updateTitle = useCallback(
    (id: string, title: string) =>
      setPages((old) => old.map((p) => (p.id === id ? { ...p, title } : p))),
    [],
  );
  const value = useMemo(
    () => ({
      spaces,
      space: spaces.find((s) => s.id === spaceId) ?? null,
      pages,
      pageId,
      loading,
      error,
      refresh,
      createPage,
      updateTitle,
      can: (key: string) => access.permissions.includes(`wiki.${key}`),
    }),
    [
      spaces,
      spaceId,
      pages,
      pageId,
      loading,
      error,
      refresh,
      createPage,
      updateTitle,
      access.permissions,
    ],
  );
  return <Context value={value}>{children}</Context>;
}
