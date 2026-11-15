import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate, useSearchParams } from "react-router";
import { t } from "../../shared/i18n/index.ts";
import type { WikiPage } from "../../shared/wiki";
import { api, errorMessage } from "../lib/api";
import { useWiki } from "./wiki-context";
import { WikiSpaceDialog } from "./wiki-controls";
import { Button, Icon, Menu, MenuPopup, useNotifications } from "./ui";
import { WorkspaceIconButton } from "./workspace-controls";
import { WorkspaceNavigationDrawer } from "./workspace-navigation";
import { useWorkspaceMobile } from "../lib/workspace-responsive";
import { WikiSearch } from "./wiki-search";
export { WikiDialog } from "./wiki-controls";

export function WikiSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const wiki = useWiki(),
    navigate = useNavigate(),
    [params] = useSearchParams(),
    view = params.get("view");
  const [dialog, setDialog] = useState<"create" | "settings" | null>(null),
    [error, setError] = useState(""),
    [collapsed, setCollapsed] = useState<Set<string>>(new Set());
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
                    <Menu.Item
                      onClick={() => {
                        void api(`/api/wiki/pages/${page.id}/favorite`, {
                          method: page.favorite ? "DELETE" : "PUT",
                        })
                          .then(wiki.refresh)
                          .catch((error) => setError(errorMessage(error)));
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
            <Button
              variant="ghost"
              className="wiki-sidebar-search"
              aria-label={t("wiki.search")}
              onClick={() => {
                onNavigate?.();
                wiki.setSearchOpen(true);
              }}
            >
              <Icon name="search" />
              <span>{t("wiki.search")}</span>
              <kbd aria-hidden="true">{t("wiki.searchShortcut")}</kbd>
            </Button>
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
            <section className="workspace-nav wiki-favorites">
              <h2>{t("wiki.favorites")}</h2>
              <ul>
                {wiki.pages
                  .filter((page) => page.favorite && page.role > 0)
                  .map((page) => (
                    <li key={page.id}>{pageLink(page)}</li>
                  ))}
              </ul>
            </section>
          )}
          <div className="wiki-tree-heading">
            <span>
              {t(wiki.space.kind === "personal" ? "wiki.privatePages" : "wiki.teamSpace")}
            </span>
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
          <nav className="wiki-tree" aria-label={t("wiki.allPages")} aria-busy={wiki.loading}>
            {children.size ? (
              tree(null)
            ) : (
              <p className="wiki-sidebar-empty">
                {t(wiki.loading ? "wiki.loading" : "wiki.noPagesYet")}
              </p>
            )}
          </nav>
          {wiki.space.role >= 3 && wiki.can("pages.create") && (
            <Button
              className="wiki-add-page"
              variant="ghost"
              disabled={wiki.creatingPage}
              onClick={() => newPage()}
            >
              <Icon name="plus" />
              {t("wiki.newPage")}
            </Button>
          )}
          {wiki.spaces.length > 1 && (
            <nav className="workspace-nav wiki-other-spaces" aria-label={t("wiki.spaces")}>
              <h2>{t("wiki.spaces")}</h2>
              {wiki.spaces
                .filter((space) => space.id !== wiki.space?.id)
                .map((space) => (
                  <Link key={space.id} to={`/wiki/${space.id}`} onClick={onNavigate}>
                    <Icon name={space.kind === "personal" ? "user" : "book"} />
                    <span>{space.name}</span>
                  </Link>
                ))}
            </nav>
          )}
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
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && ["k", "p"].includes(event.key.toLowerCase())) {
        if (
          event.key.toLowerCase() === "k" &&
          (event.target as HTMLElement).closest('[contenteditable="true"]') &&
          !window.getSelection()?.isCollapsed
        )
          return;
        event.preventDefault();
        wiki.setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [wiki.setSearchOpen]);
  const create = (
    <WorkspaceIconButton
      icon="plus"
      label={t("wiki.newPage")}
      disabled={
        !wiki.space || wiki.space.role < 3 || !wiki.can("pages.create") || wiki.creatingPage
      }
      onClick={() => void wiki.createPage().catch((error) => notify.error(errorMessage(error)))}
    />
  );
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
        <div id="wiki-topbar-content" className="wiki-topbar-content">
          {!wiki.pageId && (
            <>
              <span className="wiki-topbar-space">{wiki.space?.name || t("wiki.title")}</span>
              <div className="wiki-topbar-end">
                <WorkspaceIconButton
                  icon="search"
                  label={t("wiki.search")}
                  onClick={() => wiki.setSearchOpen(true)}
                />
                {create}
              </div>
            </>
          )}
        </div>
      </header>
      <WikiSearch />
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
