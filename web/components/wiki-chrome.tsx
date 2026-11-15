import { useAccount } from "./account-context";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate, useSearchParams } from "react-router";
import { t } from "../../shared/i18n/index.ts";
import type { WikiPage } from "../../shared/wiki";
import { api, errorMessage } from "../lib/api";
import { useWiki } from "./wiki-context";
import { WikiSpaceDialog } from "./wiki-controls";
import { Button, Icon, Menu, MenuPopup, useNotifications } from "./ui";
import { WorkspaceCreateButton, WorkspaceIconButton } from "./workspace-controls";
import { WorkspaceNavigationDrawer } from "./workspace-navigation";
import { useWorkspaceMobile } from "../lib/workspace-responsive";
import { WikiSearch } from "./wiki-search";
export { WikiDialog } from "./wiki-controls";

export function WikiSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const account = useAccount(),
    notify = useNotifications(),
    wiki = useWiki();
  const storageKey = `officeflare.wiki.tree.${account.user?.id}.${wiki.space?.id}`;
  const navigate = useNavigate(),
    [params] = useSearchParams(),
    view = params.get("view");
  const [dialog, setDialog] = useState<"create" | "settings" | null>(null),
    [collapsed, setCollapsed] = useState<Set<string>>(() => {
      try {
        return new Set(JSON.parse(localStorage.getItem(storageKey) ?? "[]"));
      } catch {
        return new Set();
      }
    });
  useEffect(() => {
    try {
      setCollapsed(new Set(JSON.parse(localStorage.getItem(storageKey) ?? "[]")));
    } catch {
      setCollapsed(new Set());
    }
  }, [storageKey]);
  const [sections, setSections] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(storageKey + ".sections") ?? "[]"));
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    try {
      setSections(new Set(JSON.parse(localStorage.getItem(storageKey + ".sections") ?? "[]")));
    } catch {
      setSections(new Set());
    }
  }, [storageKey]);
  const currentPageLoaded = wiki.pages.some((p) => p.id === wiki.pageId);
  useEffect(() => {
    if (wiki.pageId && !currentPageLoaded) return;
    // Drawer remounts keep the user's choices; a different page reveals its ancestors.
    try {
      if (sessionStorage.getItem(storageKey + ".current") === (wiki.pageId ?? "")) return;
      sessionStorage.setItem(storageKey + ".current", wiki.pageId ?? "");
    } catch {}
    if (!wiki.pageId) return;
    setSections((old) => {
      const next = new Set(old);
      next.delete("pages");
      try {
        localStorage.setItem(storageKey + ".sections", JSON.stringify([...next]));
      } catch {}
      return next;
    });
    setCollapsed((old) => {
      const next = new Set(old);
      let page = wiki.pages.find((p) => p.id === wiki.pageId);
      const seen = new Set<string>();
      while (page?.parent_id && !seen.has(page.parent_id)) {
        seen.add(page.parent_id);
        next.delete(page.parent_id);
        page = wiki.pages.find((p) => p.id === page?.parent_id);
      }
      try {
        localStorage.setItem(storageKey, JSON.stringify([...next]));
      } catch {}
      return next;
    });
    const frame = requestAnimationFrame(() =>
      document
        .querySelector('.wiki-tree a[aria-current="page"]')
        ?.scrollIntoView({ block: "nearest" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [storageKey, wiki.pageId, currentPageLoaded]);
  const toggleSection = (key: string, open: boolean) =>
    setSections((old) => {
      const next = new Set(old);
      if (open) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(storageKey + ".sections", JSON.stringify([...next]));
      } catch {}
      return next;
    });
  const [ordering, setOrdering] = useState(false);
  const reorder = async (page: WikiPage, direction: string) => {
    if (ordering) return;
    setOrdering(true);
    try {
      await api(`/api/wiki/pages/${page.id}/order`, {
        method: "POST",
        body: { direction, version: page.version },
      });
      wiki.refresh();
    } catch (e) {
      notify.error(errorMessage(e));
    } finally {
      setOrdering(false);
    }
  };
  const persist = (next: Set<string>) => {
    try {
      localStorage.setItem(storageKey, JSON.stringify([...next]));
    } catch {}
    return next;
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
      .catch((failure) => notify.error(errorMessage(failure)));
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
                {pageLink(page)}
                {nested && (
                  <Button
                    className="wiki-tree-toggle"
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
                        return persist(next);
                      })
                    }
                  >
                    <Icon name={expanded ? "down" : "chevron"} />
                  </Button>
                )}
                <Menu.Root>
                  <Menu.Trigger
                    render={
                      <Button
                        className="wiki-tree-more"
                        variant="ghost"
                        size="icon"
                        aria-label={t("wiki.pageActions")}
                      />
                    }
                  >
                    <Icon name="more" />
                  </Menu.Trigger>
                  <MenuPopup>
                    {page.role >= 4 && wiki.can("sharing.internal") && (
                      <Menu.Item
                        onClick={() => go(`/wiki/${page.space_id}/${page.id}?action=share`)}
                      >
                        <Icon name="users" />
                        {t("wiki.share")}
                      </Menu.Item>
                    )}
                    <Menu.Item
                      onClick={() =>
                        void (
                          navigator.clipboard?.writeText(
                            `${location.origin}/wiki/${page.space_id}/${page.id}`,
                          ) ?? Promise.reject()
                        )
                          .then(() => notify.success(t("wiki.linkCopied")))
                          .catch(() => notify.error(t("wiki.copyLinkFailed")))
                      }
                    >
                      <Icon name="link" />
                      {t("wiki.copyLink")}
                    </Menu.Item>

                    {page.role >= 3 && wiki.can("pages.create") && (
                      <Menu.Item disabled={wiki.creatingPage} onClick={() => newPage(page.id)}>
                        <Icon name="plus" />
                        {t("wiki.newChildPage")}
                      </Menu.Item>
                    )}
                    {wiki.space &&
                      wiki.space.role >= 4 &&
                      wiki.can("pages.move") &&
                      ["up", "down"].map((direction) => (
                        <Menu.Item
                          key={direction}
                          disabled={
                            ordering ||
                            (children.get(parent) ?? []).findIndex((p) => p.id === page.id) ===
                              (direction === "up" ? 0 : (children.get(parent) ?? []).length - 1)
                          }
                          onClick={() => void reorder(page, direction)}
                        >
                          {t(direction === "up" ? "wiki.moveUp" : "wiki.moveDown")}
                        </Menu.Item>
                      ))}
                    <Menu.Item
                      onClick={() => {
                        void api(`/api/wiki/pages/${page.id}/favorite`, {
                          method: page.favorite ? "DELETE" : "PUT",
                        })
                          .then(wiki.refresh)
                          .catch((error) => notify.error(errorMessage(error)));
                      }}
                    >
                      <Icon name="star" />
                      {t(page.favorite ? "wiki.unfavorite" : "wiki.favorite")}
                    </Menu.Item>
                    {page.role >= 3 && wiki.can("pages.update") && (
                      <Menu.Item
                        onClick={() => go(`/wiki/${page.space_id}/${page.id}?action=rename`)}
                      >
                        <Icon name="edit" />
                        {t("wiki.rename")}
                      </Menu.Item>
                    )}
                    {page.role >= 4 && wiki.can("pages.move") && (
                      <Menu.Item
                        onClick={() => go(`/wiki/${page.space_id}/${page.id}?action=move`)}
                      >
                        <Icon name="move" />
                        {t("wiki.move")}
                      </Menu.Item>
                    )}
                    {page.role >= 3 && wiki.can("pages.delete") && (
                      <>
                        <Menu.Separator />
                        <Menu.Item
                          data-variant="danger"
                          onClick={() => go(`/wiki/${page.space_id}/${page.id}?action=trash`)}
                        >
                          <Icon name="trash" />
                          {t("wiki.trashPage")}
                        </Menu.Item>
                      </>
                    )}
                  </MenuPopup>
                </Menu.Root>
              </div>
              {nested && expanded && tree(page.id, depth + 1)}
            </li>
          );
        })}
      </ul>
    );
  return (
    <div className="wiki-sidebar">
      <div className="workspace-create-action">
        <WorkspaceCreateButton
          label={t("wiki.newPage")}
          disabled={
            !wiki.space || wiki.space.role < 3 || !wiki.can("pages.create") || wiki.creatingPage
          }
          onClick={() => newPage()}
        />
      </div>
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
          <Icon name={wiki.space?.kind === "personal" ? "user" : "book"} />
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
          <nav className="workspace-nav wiki-quick-nav" aria-label={t("wiki.spaceNavigation")}>
            <Link
              to={`/wiki/${wiki.space.id}`}
              onClick={onNavigate}
              aria-current={!wiki.pageId && !view && !params.has("q") ? "page" : undefined}
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
          {wiki.pages.some((page) => page.favorite && page.role > 0) && (
            <details
              className="workspace-nav wiki-favorites"
              open={!sections.has("favorites")}
              onToggle={(e) => toggleSection("favorites", e.currentTarget.open)}
            >
              <summary>{t("wiki.favorites")}</summary>
              <ul>
                {wiki.pages
                  .filter((page) => page.favorite && page.role > 0)
                  .map((page) => (
                    <li key={page.id}>{pageLink(page)}</li>
                  ))}
              </ul>
            </details>
          )}
          <details
            className="wiki-pages-section"
            open={!sections.has("pages")}
            onToggle={(e) => toggleSection("pages", e.currentTarget.open)}
          >
            <summary className="wiki-tree-heading">
              <span>
                {t(wiki.space.kind === "personal" ? "wiki.privatePages" : "wiki.teamSpace")}
              </span>
            </summary>
            <nav className="wiki-tree" aria-label={t("wiki.allPages")} aria-busy={wiki.loading}>
              {children.size ? (
                tree(null)
              ) : (
                <p className="wiki-sidebar-empty">
                  {t(wiki.loading ? "wiki.loading" : "wiki.noPagesYet")}
                </p>
              )}
            </nav>
          </details>
          <div className="workspace-nav wiki-sidebar-footer">
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
          <Button className="wiki-add-page" variant="ghost" onClick={() => setDialog("create")}>
            <Icon name="plus" />
            {t("wiki.newSpace")}
          </Button>
        )
      )}
      {wiki.error && (
        <p role="alert" className="wiki-error">
          {wiki.error}
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

export function WikiTopbar({
  mobileAccount,
  sidebarCollapsed,
  onToggleSidebar,
}: {
  mobileAccount: ReactNode;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}) {
  const wiki = useWiki(),
    location = useLocation(),
    mobile = useWorkspaceMobile(),
    notify = useNotifications();
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [location.pathname]);
  return (
    <>
      <header className="workspace-topbar wiki-topbar">
        <WorkspaceIconButton
          icon="menu"
          label={t(mobile ? "routesWorkspace.openNavigation" : "wiki.toggleNavigation")}
          aria-expanded={mobile ? menu : !sidebarCollapsed}
          aria-haspopup={mobile ? "dialog" : undefined}
          onClick={() => (mobile ? setMenu(true) : onToggleSidebar())}
        />
        <WikiSearch />
      </header>
      {mobile && wiki.space && wiki.space.role >= 3 && wiki.can("pages.create") && (
        <Button
          className="wiki-create-page"
          variant="primary"
          disabled={wiki.creatingPage}
          onClick={() => void wiki.createPage().catch((error) => notify.error(errorMessage(error)))}
        >
          <Icon name="plus" />
          {t("wiki.newPage")}
        </Button>
      )}
      <WorkspaceNavigationDrawer
        open={menu}
        onOpenChange={setMenu}
        title={t("wiki.title")}
        account={mobileAccount}
      >
        <WikiSidebar onNavigate={() => setMenu(false)} />
      </WorkspaceNavigationDrawer>
    </>
  );
}
