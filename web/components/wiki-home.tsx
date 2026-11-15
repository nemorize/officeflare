import { useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { t } from "../../shared/i18n/index.ts";
import type { WikiPage } from "../../shared/wiki";
import { formatDateTime, getRegionalLocale } from "../lib/regional";
import { useWiki } from "./wiki-context";
import { WikiSpaceDialog } from "./wiki-controls";
import { WorkspaceIconButton } from "./workspace-controls";
import { WorkspaceEmptyState } from "./workspace-empty-state";
import { Button, Icon, Menu, MenuPopup } from "./ui";

export function WikiPageTable({
  pages,
  trash = false,
  actions,
}: {
  pages: WikiPage[];
  trash?: boolean;
  actions?: (page: WikiPage) => ReactNode;
}) {
  return (
    <table className="wiki-page-table">
      <thead>
        <tr>
          <th scope="col">{t("wiki.pageTitle")}</th>
          <th scope="col">{t("wiki.lastModified")}</th>
          <th scope="col">
            <span className="visually-hidden">{t("wiki.pageActions")}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {pages.map((page) => (
          <tr key={page.id}>
            <td>
              {trash ? (
                <span className="wiki-page-link">
                  <span className="wiki-page-glyph" aria-hidden="true">
                    {page.icon || <Icon name="file" />}
                  </span>
                  {page.title || t("wiki.untitled")}
                </span>
              ) : (
                <Link className="wiki-page-link" to={`/wiki/${page.space_id}/${page.id}`}>
                  <span className="wiki-page-glyph" aria-hidden="true">
                    {page.icon || <Icon name="file" />}
                  </span>
                  <span>{page.title || t("wiki.untitled")}</span>
                  {!!page.favorite && (
                    <Icon
                      name="star"
                      className="wiki-starred-icon"
                      aria-label={t("wiki.favorites")}
                    />
                  )}
                  {page.permission_mode === "restricted" && (
                    <Icon name="shield" aria-label={t("wiki.restricted")} />
                  )}
                </Link>
              )}
            </td>
            <td>
              <time dateTime={new Date(page.updated_at * 1000).toISOString()}>
                {formatDateTime(page.updated_at, { dateStyle: "medium" })}
              </time>
            </td>
            <td>{actions && <div className="wiki-row-actions">{actions(page)}</div>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function WikiStarred() {
  const wiki = useWiki(),
    [params, setParams] = useSearchParams(),
    sort = params.get("sort") === "updated_at" ? "updated_at" : "name",
    order = params.get("order") === "desc" ? "desc" : "asc";
  // The sidebar loads every page, so sorting includes all starred pages in this space.
  const pages = wiki.pages
    .filter((page) => page.favorite && page.role > 0 && !page.trashed_at)
    .sort((a, b) => {
      const comparison =
        sort === "updated_at"
          ? a.updated_at - b.updated_at
          : (a.title || t("wiki.untitled")).localeCompare(
              b.title || t("wiki.untitled"),
              getRegionalLocale(),
              { numeric: true, sensitivity: "base" },
            );
      return (comparison || a.id.localeCompare(b.id)) * (order === "asc" ? 1 : -1);
    });
  const change = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next);
  };
  return (
    <section className="wiki-settings wiki-starred-page">
      <h1>{t("wiki.favorites")}</h1>
      <div className="wiki-list-toolbar">
        <Menu.Root>
          <Menu.Trigger
            render={<Button variant="ghost" size="sm" />}
            aria-label={t("wiki.sortPages")}
          >
            <Icon name="sort" />
            <span>{t(sort === "name" ? "common.name" : "wiki.lastModified")}</span>
            <Icon name="down" width="12" height="12" />
          </Menu.Trigger>
          <MenuPopup data-ui-theme="neutral" positionerProps={{ align: "end" }}>
            {[
              { value: "name", label: t("common.name") },
              { value: "updated_at", label: t("wiki.lastModified") },
            ].map((option) => (
              <Menu.Item key={option.value} onClick={() => change("sort", option.value)}>
                <Icon name={sort === option.value ? "check" : "circle"} />
                {option.label}
              </Menu.Item>
            ))}
            <Menu.Separator />
            <Menu.Item onClick={() => change("order", order === "asc" ? "desc" : "asc")}>
              <Icon name="sort" />
              {t(order === "asc" ? "wiki.switchToDescending" : "wiki.switchToAscending")}
            </Menu.Item>
          </MenuPopup>
        </Menu.Root>
      </div>
      {wiki.error && (
        <p className="wiki-error" role="alert">
          {wiki.error}
        </p>
      )}
      {pages.length ? (
        <WikiPageTable pages={pages} />
      ) : !wiki.error ? (
        <WorkspaceEmptyState icon="star" title={t("wiki.noFavorites")} />
      ) : null}
    </section>
  );
}

export function WikiHome() {
  const wiki = useWiki(),
    [dialog, setDialog] = useState<"create" | "settings" | null>(null);
  const pages = wiki.pages
    .filter((page) => page.role > 0)
    .sort((a, b) => b.updated_at - a.updated_at || a.id.localeCompare(b.id));
  return (
    <div className="wiki-home">
      <header className="wiki-home-heading">
        <div>
          <h1>{wiki.space?.name || t("wiki.title")}</h1>
          {wiki.space?.description && (
            <p className="wiki-home-description">{wiki.space.description}</p>
          )}
        </div>
        <div className="wiki-home-actions">
          {wiki.space && wiki.space.role >= 4 && wiki.can("sharing.internal") && (
            <WorkspaceIconButton
              icon="settings"
              label={t("wiki.spaceSettings")}
              onClick={() => setDialog("settings")}
            />
          )}
          {!wiki.space && wiki.can("spaces.create") && (
            <Button variant="primary" onClick={() => setDialog("create")}>
              <Icon name="plus" />
              {t("wiki.newSpace")}
            </Button>
          )}
        </div>
      </header>
      {wiki.error && (
        <p role="alert" className="wiki-error">
          {wiki.error}
        </p>
      )}
      {wiki.space && pages.length > 0 ? (
        <section className="wiki-home-pages" aria-labelledby="wiki-pages-heading">
          <div className="wiki-home-section-heading">
            <h2 id="wiki-pages-heading">{t("wiki.allPages")}</h2>
            <span>{t("wiki.pageCount", { count: pages.length })}</span>
          </div>
          <WikiPageTable pages={pages} />
        </section>
      ) : (
        <section className="wiki-list-empty">
          <Icon name="book" />
          <h2>{t(wiki.space ? "wiki.noPagesYet" : "wiki.noSpaces")}</h2>
        </section>
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
