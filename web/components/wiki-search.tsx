import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { t } from "../../shared/i18n/index.ts";
import type { WikiPage } from "../../shared/wiki";
import { api, errorMessage } from "../lib/api";
import { useWiki } from "./wiki-context";
import { Button, Dialog, DialogPopup, Icon, Input } from "./ui";

export function WikiSearch() {
  const wiki = useWiki(),
    navigate = useNavigate(),
    resultsId = useId();
  const [query, setQuery] = useState(""),
    [results, setResults] = useState<WikiPage[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [selected, setSelected] = useState(0),
    [cursor, setCursor] = useState<string | null>(null);
  const chosen = useRef<string | undefined>(undefined);
  chosen.current = results[selected]?.id;
  const chooseResults = (next: WikiPage[]) => {
    setSelected(
      Math.max(
        0,
        next.findIndex((p) => p.id === chosen.current),
      ),
    );
    setResults(next);
  };
  const controller = useRef<AbortController | null>(null),
    list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!wiki.searchOpen || !wiki.space) return;
    const abort = new AbortController();
    controller.current = abort;

    setError("");
    setCursor(null);
    if (!query.trim()) {
      chooseResults(
        wiki.pages
          .filter((p) => p.role > 0)
          .sort((a, b) => b.updated_at - a.updated_at)
          .slice(0, 12),
      );
      setBusy(false);
      return () => abort.abort();
    }
    const local = wiki.pages.filter(
      (page) =>
        page.role > 0 && page.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
    );
    setBusy(true);
    chooseResults(local);
    const timer = setTimeout(
      () =>
        void api<{ pages: WikiPage[]; next_cursor: string | null }>(
          `/api/wiki/spaces/${wiki.space!.id}/pages?q=${encodeURIComponent(query.trim())}`,
          { signal: abort.signal },
        )
          .then((data) => {
            if (!abort.signal.aborted) {
              const found = new Map(data.pages.map((page) => [page.id, page]));
              for (const page of local) found.set(page.id, page);
              chooseResults([...found.values()]);
              setCursor(data.next_cursor);
            }
          })
          .catch((failure) => {
            if (!abort.signal.aborted) setError(errorMessage(failure));
          })
          .finally(() => {
            if (!abort.signal.aborted) setBusy(false);
          }),
      200,
    );
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [query, wiki.space?.id, wiki.searchOpen, wiki.pages]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const open = (page: WikiPage) => {
    setQuery("");
    wiki.setSearchOpen(false);
    navigate(`/wiki/${page.space_id}/${page.id}`);
  };
  const more = async () => {
    const abort = controller.current;
    if (!cursor || !wiki.space || busy || !abort || abort.signal.aborted) return;
    setBusy(true);
    try {
      const data = await api<{ pages: WikiPage[]; next_cursor: string | null }>(
        `/api/wiki/spaces/${wiki.space.id}/pages?q=${encodeURIComponent(query.trim())}&cursor=${encodeURIComponent(cursor)}`,
        { signal: abort.signal },
      );
      if (!abort.signal.aborted) {
        setResults((old) => [
          ...new Map([...old, ...data.pages].map((page) => [page.id, page])).values(),
        ]);
        setCursor(data.next_cursor);
      }
    } catch (failure) {
      if (!abort.signal.aborted) setError(errorMessage(failure));
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  };
  return (
    <Dialog.Root
      open={wiki.searchOpen}
      onOpenChange={(open) => {
        wiki.setSearchOpen(open);
        if (!open) setQuery("");
      }}
    >
      <DialogPopup
        padding="none"
        className="wiki-search-dialog"
        viewportProps={{ className: "wiki-search-viewport" }}
      >
        <Dialog.Title className="visually-hidden">{t("wiki.search")}</Dialog.Title>
        <div className="wiki-search-input">
          <Icon name="search" />
          <Input
            autoFocus
            type="search"
            variant="integrated"
            aria-label={t("wiki.search")}
            aria-controls={resultsId}
            aria-activedescendant={
              results[selected] ? `${resultsId}-${results[selected].id}` : undefined
            }
            placeholder={t("wiki.search")}
            value={query}
            maxLength={100}
            onChange={(event) => {
              chosen.current = undefined;
              setSelected(0);
              setQuery(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setSelected((index) =>
                  Math.max(
                    0,
                    Math.min(results.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)),
                  ),
                );
              }
              if (event.key === "Enter" && results[selected]) {
                event.preventDefault();
                open(results[selected]);
              }
            }}
          />
          {query && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("wiki.clearSearch")}
              onClick={() => setQuery("")}
            >
              <Icon name="close" />
            </Button>
          )}
          <Dialog.Close render={<Button variant="ghost" size="sm" aria-label={t("wiki.close")} />}>
            {t("wiki.escapeShortcut")}
          </Dialog.Close>
        </div>
        <div className="wiki-search-caption">
          {t(query.trim() ? "wiki.searchResults" : "wiki.recentPages")}
        </div>
        <div
          ref={list}
          id={resultsId}
          role="listbox"
          aria-label={t("wiki.searchResults")}
          aria-busy={busy}
          className="wiki-search-results"
        >
          {results.map((page, index) => (
            <button
              type="button"
              role="option"
              aria-selected={index === selected}
              key={page.id}
              id={`${resultsId}-${page.id}`}
              onMouseMove={() => setSelected(index)}
              onClick={() => open(page)}
            >
              <span aria-hidden="true">{page.icon || <Icon name="file" />}</span>
              <span>
                <strong>{page.title || t("wiki.untitled")}</strong>
                <small>
                  {wiki.pages.find((parent) => parent.id === page.parent_id)?.title ||
                    wiki.space?.name}
                </small>
              </span>
              <Icon name="arrow" />
            </button>
          ))}
          {busy ? (
            <p role="status">{t("wiki.searching")}</p>
          ) : !results.length && !error ? (
            <p>{t("wiki.noResults")}</p>
          ) : null}
          {error && (
            <p role="alert" className="wiki-error">
              {error}
            </p>
          )}
          {cursor && (
            <Button variant="ghost" disabled={busy} onClick={() => void more()}>
              {t("wiki.loadMore")}
            </Button>
          )}
        </div>
      </DialogPopup>
    </Dialog.Root>
  );
}
