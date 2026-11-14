import { useState } from "react";
import { Link } from "react-router";
import { t } from "../../shared/i18n/index.ts";
import type { WikiPage } from "../../shared/wiki";
import { errorMessage } from "../lib/api";
import { formatDateTime } from "../lib/regional";
import { useWiki } from "./wiki-context";
import { WikiSpaceDialog } from "./wiki-controls";
import { Button, Icon } from "./ui";

export function WikiHome() {
  const wiki = useWiki(),
    [dialog, setDialog] = useState<"create" | "settings" | null>(null),
    [error, setError] = useState("");
  const visible = wiki.pages.filter((page) => page.role > 0),
    recent = [...visible]
      .sort((a, b) => b.updated_at - a.updated_at || a.id.localeCompare(b.id))
      .slice(0, 6),
    roots = visible.filter(
      (page) => !page.parent_id || !visible.some((parent) => parent.id === page.parent_id),
    );
  const newPage = () => void wiki.createPage().catch((failure) => setError(errorMessage(failure)));
  const row = (page: WikiPage) => (
    <Link className="wiki-page-row" key={page.id} to={`/wiki/${page.space_id}/${page.id}`}>
      <span className="wiki-page-glyph">{page.icon || <Icon name="file" />}</span>
      <strong>{page.title || t("wiki.untitled")}</strong>
      {page.permission_mode === "restricted" && (
        <Icon name="shield" aria-label={t("wiki.restricted")} />
      )}
      <time dateTime={new Date(page.updated_at * 1000).toISOString()}>
        {formatDateTime(page.updated_at, { dateStyle: "medium" })}
      </time>
      <Icon name="chevron" />
    </Link>
  );
  return (
    <div className="wiki-home">
      <header className="wiki-home-heading">
        <div className="wiki-home-symbol">
          <Icon name={wiki.space?.kind === "personal" ? "user" : "book"} width="28" height="28" />
        </div>
        <div>
          <p className="wiki-eyebrow">{t("wiki.title")}</p>
          <h1>{wiki.space?.name || t("wiki.welcome")}</h1>
          <p className="wiki-home-description">
            {wiki.space?.description ||
              t(wiki.space ? "wiki.spaceIntro" : "wiki.welcomeDescription")}
          </p>
        </div>
        <div className="wiki-home-actions">
          {wiki.space && wiki.space.role >= 4 && wiki.can("sharing.internal") && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("wiki.spaceSettings")}
              onClick={() => setDialog("settings")}
            >
              <Icon name="settings" />
            </Button>
          )}
          {wiki.space && wiki.space.role >= 3 && wiki.can("pages.create") ? (
            <Button variant="primary" disabled={wiki.creatingPage} onClick={newPage}>
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
      {wiki.space && !!visible.length && (
        <>
          <section aria-labelledby="wiki-recent-heading">
            <div className="wiki-home-section-heading">
              <h2 id="wiki-recent-heading">
                <Icon name="clock" />
                {t("wiki.recentPages")}
              </h2>
              <span>{t("wiki.pageCount", { count: visible.length })}</span>
            </div>
            <div className="wiki-recent-grid">
              {recent.map((page) => (
                <Link
                  className="wiki-recent-card"
                  key={page.id}
                  to={`/wiki/${page.space_id}/${page.id}`}
                >
                  <span className="wiki-page-glyph">{page.icon || <Icon name="file" />}</span>
                  <strong>{page.title || t("wiki.untitled")}</strong>
                  <small>
                    {t("wiki.updatedDate", {
                      date: formatDateTime(page.updated_at, { dateStyle: "medium" }),
                    })}
                  </small>
                </Link>
              ))}
            </div>
          </section>
          {!!visible.filter((page) => page.favorite).length && (
            <section aria-labelledby="wiki-pinned-heading">
              <div className="wiki-home-section-heading">
                <h2 id="wiki-pinned-heading">
                  <Icon name="star" />
                  {t("wiki.favorites")}
                </h2>
              </div>
              <div className="wiki-page-directory">
                {visible.filter((page) => page.favorite).map(row)}
              </div>
            </section>
          )}
          <section aria-labelledby="wiki-directory-heading">
            <div className="wiki-home-section-heading">
              <h2 id="wiki-directory-heading">
                <Icon name="layers" />
                {t("wiki.allPages")}
              </h2>
            </div>
            <div className="wiki-page-directory">{roots.map(row)}</div>
          </section>
        </>
      )}
      {!visible.length && (
        <section className="wiki-onboarding">
          <div className="wiki-onboarding-drawing" aria-hidden="true">
            <span>
              <Icon name="book" width="44" height="44" />
            </span>
            <i>
              <Icon name="file" width="26" height="26" />
            </i>
          </div>
          <h2>{t(wiki.space ? "wiki.firstPage" : "wiki.welcome")}</h2>
          <p>{t(wiki.space ? "wiki.firstPageDescription" : "wiki.welcomeDescription")}</p>
          {wiki.space && wiki.space.role >= 3 && wiki.can("pages.create") && (
            <Button variant="primary" disabled={wiki.creatingPage} onClick={newPage}>
              <Icon name="plus" />
              {t("wiki.newPage")}
            </Button>
          )}
          <div className="wiki-onboarding-features">
            <span>
              <Icon name="layers" />
              {t("wiki.organizeHint")}
            </span>
            <span>
              <Icon name="users" />
              {t("wiki.collaborateHint")}
            </span>
            <span>
              <Icon name="shield" />
              {t("wiki.accessHint")}
            </span>
          </div>
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
