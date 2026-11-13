import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useNavigate } from "react-router";
import { t } from "../../shared/i18n/index.ts";
import type { WikiPage, WikiSpace } from "../../shared/wiki";
import { api, errorMessage } from "../lib/api";
import { useWiki } from "./wiki-context";
import { Button, Dialog, DialogPopup, Icon, Input } from "./ui";
export function WikiDialog({
  title,
  open,
  onClose,
  children,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogPopup className="wiki-dialog">
        <div className="wiki-dialog-heading">
          <Dialog.Title>{title}</Dialog.Title>
          <Button variant="ghost" size="icon" aria-label={t("wiki.close")} onClick={onClose}>
            <Icon name="close" />
          </Button>
        </div>
        {children}
      </DialogPopup>
    </Dialog.Root>
  );
}
export function WikiSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const wiki = useWiki(),
    navigate = useNavigate();
  const [creating, setCreating] = useState(false),
    [name, setName] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [query, setQuery] = useState(""),
    [results, setResults] = useState<WikiPage[] | null>(null),
    [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => {
    setQuery("");
    setResults(null);
  }, [wiki.space?.id]);
  useEffect(() => {
    if (!query.trim() || !wiki.space) {
      setResults(null);
      return;
    }
    const controller = new AbortController(),
      timer = setTimeout(() => {
        void api<{ pages: WikiPage[] }>(
          `/api/wiki/spaces/${wiki.space!.id}/pages?q=${encodeURIComponent(query.trim())}`,
          { signal: controller.signal },
        )
          .then((v) => {
            if (!controller.signal.aborted) setResults(v.pages);
          })
          .catch((e) => {
            if (!controller.signal.aborted) setError(errorMessage(e));
          });
      }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, wiki.space?.id]);
  const go = (path: string) => {
    navigate(path);
    onNavigate?.();
  };
  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ space: WikiSpace }>("/api/wiki/spaces", {
        method: "POST",
        body: { name },
      });
      setCreating(false);
      setName("");
      wiki.refresh();
      go(`/wiki/${result.space.id}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const pageLink = (page: WikiPage) => (
    <NavLink to={`/wiki/${page.space_id}/${page.id}`} onClick={onNavigate}>
      <span>{page.icon || <Icon name="file" />}</span>
      <span>{page.title || t("wiki.untitled")}</span>
    </NavLink>
  );
  const tree = (parent: string | null, depth = 0): ReactNode =>
    depth > 32 ? null : (
      <ul>
        {wiki.pages
          .filter((p) =>
            parent === null
              ? !p.parent_id || !wiki.pages.some((other) => other.id === p.parent_id)
              : p.parent_id === parent,
          )
          .sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id))
          .map((page) => {
            const nested = wiki.pages.some((p) => p.parent_id === page.id),
              expanded = !collapsed.has(page.id);
            return (
              <li key={page.id}>
                <div className="wiki-tree-row">
                  {nested ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={page.title || t("wiki.untitled")}
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
                      variant="ghost"
                      size="icon"
                      aria-label={t("wiki.newPage")}
                      onClick={() =>
                        void wiki
                          .createPage(page.id)
                          .then(onNavigate)
                          .catch((e) => setError(errorMessage(e)))
                      }
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
      <select
        aria-label={t("wiki.spaces")}
        value={wiki.space?.id ?? ""}
        onChange={(event) => go(`/wiki/${event.target.value}`)}
      >
        <option value="" disabled>
          {t("wiki.spaces")}
        </option>
        {wiki.spaces.map((space) => (
          <option key={space.id} value={space.id}>
            {space.name}
          </option>
        ))}
      </select>
      {wiki.can("spaces.create") && (
        <Button variant="ghost" onClick={() => setCreating(true)}>
          <Icon name="plus" />
          {t("wiki.newSpace")}
        </Button>
      )}
      {wiki.space && (
        <>
          <Input
            type="search"
            aria-label={t("wiki.search")}
            placeholder={t("wiki.search")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            maxLength={100}
          />
          {wiki.space.role >= 3 && wiki.can("pages.create") && (
            <Button
              onClick={() =>
                void wiki
                  .createPage()
                  .then(onNavigate)
                  .catch((e) => setError(errorMessage(e)))
              }
            >
              <Icon name="plus" />
              {t("wiki.newPage")}
            </Button>
          )}
          <nav className="wiki-tree" aria-label={t("wiki.allPages")}>
            {results ? (
              <ul>
                {results.map((page) => (
                  <li key={page.id}>{pageLink(page)}</li>
                ))}
                {!results.length && <li className="wiki-muted">{t("wiki.noResults")}</li>}
              </ul>
            ) : (
              tree(null)
            )}
          </nav>
          <div className="wiki-sidebar-footer">
            <Button variant="ghost" onClick={() => go(`/wiki/${wiki.space!.id}?view=favorites`)}>
              <Icon name="star" />
              {t("wiki.favorites")}
            </Button>
            <Button variant="ghost" onClick={() => go(`/wiki/${wiki.space!.id}?view=trash`)}>
              <Icon name="trash" />
              {t("wiki.trash")}
            </Button>
            {wiki.space.role >= 4 && (
              <Button variant="ghost" onClick={() => go(`/wiki/${wiki.space!.id}?view=members`)}>
                <Icon name="users" />
                {t("wiki.members")}
              </Button>
            )}
          </div>
        </>
      )}
      {(error || wiki.error) && (
        <p role="alert" className="wiki-error">
          {error || wiki.error}
        </p>
      )}
      <WikiDialog title={t("wiki.newSpace")} open={creating} onClose={() => setCreating(false)}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <label>
            {t("wiki.spaceName")}
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={100}
              autoFocus
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <div className="wiki-dialog-actions">
            <Button onClick={() => setCreating(false)}>{t("wiki.cancel")}</Button>
            <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
              {t("wiki.create")}
            </Button>
          </div>
        </form>
      </WikiDialog>
    </div>
  );
}
