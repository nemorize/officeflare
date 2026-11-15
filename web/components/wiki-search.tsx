import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { t } from "../../shared/i18n/index.ts";
import { useWiki } from "./wiki-context";
import { Icon, Input, SearchField } from "./ui";
import { WorkspaceIconButton } from "./workspace-controls";

export function WikiSearch() {
  const wiki = useWiki(),
    navigate = useNavigate(),
    [params] = useSearchParams(),
    input = useRef<HTMLInputElement>(null);
  const currentQuery = params.get("q") ?? "";
  const [query, setQuery] = useState(currentQuery);
  useEffect(() => setQuery(currentQuery), [currentQuery, wiki.space?.id]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !["k", "p"].includes(event.key.toLowerCase()))
        return;
      if (
        event.key.toLowerCase() === "k" &&
        (event.target as HTMLElement).closest('[contenteditable="true"]') &&
        !window.getSelection()?.isCollapsed
      )
        return;
      event.preventDefault();
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  const submit = () => {
    if (!wiki.space) return;
    const value = query.trim();
    navigate(`/wiki/${wiki.space.id}${value ? `?q=${encodeURIComponent(value)}` : ""}`);
  };
  return (
    <SearchField
      className="wiki-search"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Icon name="search" />
      <Input
        ref={input}
        type="text"
        role="searchbox"
        variant="integrated"
        aria-label={t("wiki.search")}
        placeholder={t("wiki.search")}
        value={query}
        maxLength={100}
        disabled={!wiki.space}
        onChange={(event) => setQuery(event.target.value)}
      />
      {(query || currentQuery) && (
        <WorkspaceIconButton
          icon="close"
          label={t("wiki.clearSearch")}
          onClick={() => {
            setQuery("");
            if (wiki.space) navigate(`/wiki/${wiki.space.id}`);
            input.current?.focus();
          }}
        />
      )}
    </SearchField>
  );
}
