import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { t } from "../../shared/i18n/index.ts";
import type { WikiPage } from "../../shared/wiki";
import { errorMessage } from "../lib/api";
import { formatDateTime } from "../lib/regional";
import { useWiki } from "./wiki-context";
import { WikiSpaceDialog } from "./wiki-controls";
import { WorkspaceIconButton } from "./workspace-controls";
import { Button, Icon } from "./ui";

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
            <td>
              {actions ? (
                <div className="wiki-row-actions">{actions(page)}</div>
              ) : (
                !!page.favorite && <Icon name="star" aria-label={t("wiki.favorites")} />
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function WikiHome() {
  const wiki = useWiki(),
    [dialog, setDialog] = useState<"create" | "settings" | null>(null),
    [error, setError] = useState("");
  const pages = wiki.pages
    .filter((page) => page.role > 0)
    .sort((a, b) => b.updated_at - a.updated_at || a.id.localeCompare(b.id));
  const newPage = () => void wiki.createPage().catch((failure) => setError(errorMessage(failure)));
  return (
    <div className="wiki-home">
      <header className="wiki-home-heading">
        <div>
          <h1>{wiki.space?.name || t("wiki.title")}</h1>
          <p className="wiki-home-description">
            {wiki.space?.description ||
              t(wiki.space ? "wiki.spaceIntro" : "wiki.welcomeDescription")}
          </p>
        </div>
        <div className="wiki-home-actions">
          {wiki.space && wiki.space.role >= 4 && wiki.can("sharing.internal") && (
            <WorkspaceIconButton
              icon="settings"
              label={t("wiki.spaceSettings")}
              onClick={() => setDialog("settings")}
            />
          )}
          {wiki.space && wiki.space.role >= 3 && wiki.can("pages.create") ? (
            <Button disabled={wiki.creatingPage} onClick={newPage}>
              <Icon name="plus" />
              {t("wiki.newPage")}
            </Button>
          ) : !wiki.space && wiki.can("spaces.create") ? (
            <Button variant="primary" onClick={() => setDialog("create")}>
              <Icon name="plus" />
              {t("wiki.newSpace")}
            </Button>
          ) : null}
        </div>
      </header>
      {(error || wiki.error) && (
        <p role="alert" className="wiki-error">
          {error || wiki.error}
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
          <h2>{t(wiki.space ? "wiki.firstPage" : "wiki.welcome")}</h2>
          <p>{t(wiki.space ? "wiki.firstPageDescription" : "wiki.welcomeDescription")}</p>
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
