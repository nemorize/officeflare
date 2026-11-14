import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useNavigate, useSearchParams } from "react-router";
import { t } from "../../shared/i18n/index.ts";
import type { WikiPage } from "../../shared/wiki";
import { api, errorMessage } from "../lib/api";
import { useWiki } from "./wiki-context";
import { WikiSpaceDialog } from "./wiki-controls";
import { Button, Icon, Input, Menu, MenuPopup } from "./ui";
export { WikiDialog } from "./wiki-controls";

export function WikiSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const wiki = useWiki(),
    navigate = useNavigate(),
    [params] = useSearchParams(),
    view = params.get("view");
  const [dialog, setDialog] = useState<"create" | "settings" | null>(null),
    [error, setError] = useState(""),
    [query, setQuery] = useState(""),
    [results, setResults] = useState<WikiPage[] | null>(null),
    [searching, setSearching] = useState(false),
    [cursor, setCursor] = useState<string | null>(null),
    [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const input = useRef<HTMLInputElement | null>(null),
    searchRequest = useRef<AbortController | null>(null);
  const searchRevision = useMemo(
    () =>
      wiki.pages
        .map(
          (page) =>
            `${page.id}:${page.projected_epoch}:${page.projected_seq}:${page.version}:${page.role}`,
        )
        .join("|"),
    [wiki.pages],
  );
  useEffect(() => {
    setQuery("");
    setResults(null);
    setError("");
  }, [wiki.space?.id]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "k" &&
        input.current?.getClientRects().length
      ) {
        event.preventDefault();
        input.current.focus();
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  useEffect(() => {
    setCursor(null);
    if (!query.trim() || !wiki.space) {
      setResults(null);
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    searchRequest.current = controller;
    setResults(null);
    setSearching(true);
    setError("");
    const timer = setTimeout(() => {
      void api<{ pages: WikiPage[]; next_cursor: string | null }>(
        `/api/wiki/spaces/${wiki.space!.id}/pages?q=${encodeURIComponent(query.trim())}`,
        { signal: controller.signal },
      )
        .then((result) => {
          if (!controller.signal.aborted) {
            setResults(result.pages);
            setCursor(result.next_cursor);
          }
        })
        .catch((failure) => {
          if (!controller.signal.aborted) setError(errorMessage(failure));
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, wiki.space?.id, searchRevision]);
  const more = async () => {
    const controller = searchRequest.current;
    if (!cursor || !wiki.space || searching || !controller || controller.signal.aborted) return;
    setSearching(true);
    try {
      const result = await api<{ pages: WikiPage[]; next_cursor: string | null }>(
        `/api/wiki/spaces/${wiki.space.id}/pages?q=${encodeURIComponent(query.trim())}&cursor=${encodeURIComponent(cursor)}`,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setResults((previous) => [...(previous ?? []), ...result.pages]);
      setCursor(result.next_cursor);
    } catch (failure) {
      if (!controller.signal.aborted) setError(errorMessage(failure));
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  };
  const go = (path: string) => {
    navigate(path);
    onNavigate?.();
  };
  const children = useMemo(() => {
    const pages = wiki.pages.filter((page) => page.role > 0),
      ids = new Set(pages.map((page) => page.id)),
      map = new Map<string | null, WikiPage[]>();
    for (const page of pages) {
      const parent = page.parent_id && ids.has(page.parent_id) ? page.parent_id : null;
      map.set(parent, [...(map.get(parent) ?? []), page]);
    }
    for (const values of map.values())
      values.sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id));
    return map;
  }, [wiki.pages]);
  const newPage = (parentId?: string) =>
    void wiki
      .createPage(parentId)
      .then(onNavigate)
      .catch((failure) => setError(errorMessage(failure)));
  const pageLink = (page: WikiPage) => (
    <NavLink
      to={`/wiki/${page.space_id}/${page.id}`}
      onClick={onNavigate}
      title={page.title || t("wiki.untitled")}
    >
      <span className="wiki-tree-icon" aria-hidden="true">
        {page.icon || <Icon name="file" />}
      </span>
      <span>{page.title || t("wiki.untitled")}</span>
      {page.permission_mode === "restricted" && (
        <Icon name="shield" className="wiki-tree-private" />
      )}
    </NavLink>
  );
  const tree = (parent: string | null, depth = 0): ReactNode =>
    depth > 32 ? null : (
      <ul>
        {(children.get(parent) ?? []).map((page) => {
          const nested = children.has(page.id),
            expanded = !collapsed.has(page.id);
          return (
            <li key={page.id}>
              <div className="wiki-tree-row">
                {nested ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t(expanded ? "wiki.collapsePage" : "wiki.expandPage", {
                      title: page.title || t("wiki.untitled"),
                    })}
                    aria-expanded={expanded}
                    onClick={() =>
                      setCollapsed((previous) => {
                        const next = new Set(previous);
                        if (expanded) next.add(page.id);
                        else next.delete(page.id);
                        return next;
                      })
                    }
                  >
                    <Icon name={expanded ? "down" : "chevron"} />
                  </Button>
                ) : (
                  <span className="wiki-tree-spacer" />
                )}
                {pageLink(page)}
                {page.role >= 3 && wiki.can("pages.create") && (
                  <Button
                    className="wiki-tree-add"
                    variant="ghost"
                    size="icon"
                    disabled={wiki.creatingPage}
                    aria-label={t("wiki.newChildPage")}
                    onClick={() => newPage(page.id)}
                  >
                    <Icon name="plus" />
                  </Button>
                )}
              </div>
              {nested && expanded && tree(page.id, depth + 1)}
            </li>
          );
        })}
      </ul>
    );
  return (
    <div className="wiki-sidebar">
      <Menu.Root>
        <Menu.Trigger
          render={
            <Button
              variant="ghost"
              className="wiki-space-switch"
              aria-label={t("wiki.switchSpace")}
            />
          }
        >
          <span className="wiki-space-avatar">
            <Icon name={wiki.space?.kind === "personal" ? "user" : "book"} />
          </span>
          <span>
            <strong>{wiki.space?.name || t("wiki.spaces")}</strong>
            <small>
              {t(wiki.space?.kind === "personal" ? "wiki.personalSpace" : "wiki.teamSpace")}
            </small>
          </span>
          <Icon name="down" />
        </Menu.Trigger>
        <MenuPopup className="wiki-space-menu">
          {wiki.spaces.map((space) => (
            <Menu.Item key={space.id} onClick={() => go(`/wiki/${space.id}`)}>
              <Icon name={space.kind === "personal" ? "user" : "book"} />
              <span>{space.name}</span>
              {wiki.space?.id === space.id && <Icon name="check" />}
            </Menu.Item>
          ))}
          {wiki.can("spaces.create") && (
            <>
              <Menu.Separator />
              <Menu.Item onClick={() => setDialog("create")}>
                <Icon name="plus" />
                {t("wiki.newSpace")}
              </Menu.Item>
            </>
          )}
          {wiki.space && wiki.space.role >= 4 && wiki.can("sharing.internal") && (
            <Menu.Item onClick={() => setDialog("settings")}>
              <Icon name="settings" />
              {t("wiki.spaceSettings")}
            </Menu.Item>
          )}
        </MenuPopup>
      </Menu.Root>
      {wiki.space ? (
        <>
          <div className="wiki-search">
            <Icon name="search" />
            <Input
              ref={input}
              type="search"
              aria-label={t("wiki.search")}
              placeholder={t("wiki.search")}
              value={query}
              maxLength={100}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <nav className="wiki-quick-nav" aria-label={t("wiki.spaceNavigation")}>
            <Link
              to={`/wiki/${wiki.space.id}`}
              onClick={onNavigate}
              aria-current={!wiki.pageId && !view ? "page" : undefined}
            >
              <Icon name="book" />
              {t("wiki.overview")}
            </Link>
            <Link
              to={`/wiki/${wiki.space.id}?view=favorites`}
              onClick={onNavigate}
              aria-current={view === "favorites" ? "page" : undefined}
            >
              <Icon name="star" />
              {t("wiki.favorites")}
            </Link>
          </nav>
          <div className="wiki-tree-heading">
            <span>{t(query.trim() ? "wiki.searchResults" : "wiki.allPages")}</span>
            {wiki.space.role >= 3 && wiki.can("pages.create") && (
              <Button
                variant="ghost"
                size="icon"
                disabled={wiki.creatingPage}
                aria-label={t("wiki.newPage")}
                title={t("wiki.newPage")}
                onClick={() => newPage()}
              >
                <Icon name="plus" />
              </Button>
            )}
          </div>
          <nav
            className="wiki-tree"
            aria-label={t("wiki.allPages")}
            aria-busy={searching || wiki.loading}
          >
            {query.trim() ? (
              <>
                {results && (
                  <ul>
                    {results.map((page) => (
                      <li key={page.id}>{pageLink(page)}</li>
                    ))}
                  </ul>
                )}
                {searching ? (
                  <p className="wiki-sidebar-empty" role="status">
                    {t("wiki.searching")}
                  </p>
                ) : results?.length === 0 ? (
                  <p className="wiki-sidebar-empty">{t("wiki.noResults")}</p>
                ) : null}
                {cursor && (
                  <Button variant="ghost" disabled={searching} onClick={() => void more()}>
                    {t("wiki.loadMore")}
                  </Button>
                )}
              </>
            ) : children.size ? (
              tree(null)
            ) : (
              <p className="wiki-sidebar-empty">
                {t(wiki.loading ? "wiki.loading" : "wiki.noPagesYet")}
              </p>
            )}
          </nav>
          <div className="wiki-sidebar-footer">
            <Link
              to={`/wiki/${wiki.space.id}?view=trash`}
              onClick={onNavigate}
              aria-current={view === "trash" ? "page" : undefined}
            >
              <Icon name="trash" />
              {t("wiki.trash")}
            </Link>
            {wiki.space.role >= 4 && (
              <Link
                to={`/wiki/${wiki.space.id}?view=members`}
                onClick={onNavigate}
                aria-current={view === "members" ? "page" : undefined}
              >
                <Icon name="users" />
                {t("wiki.members")}
              </Link>
            )}
          </div>
        </>
      ) : (
        wiki.can("spaces.create") && (
          <Button onClick={() => setDialog("create")}>
            <Icon name="plus" />
            {t("wiki.newSpace")}
          </Button>
        )
      )}
      {(error || wiki.error) && (
        <p role="alert" className="wiki-error">
          {error || wiki.error}
        </p>
      )}
      {dialog && (
        <WikiSpaceDialog
          space={dialog === "settings" ? (wiki.space ?? undefined) : undefined}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
