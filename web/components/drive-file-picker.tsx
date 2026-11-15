import { useEffect, useRef, useState } from "react";
import { t } from "../../shared/i18n/index.ts";
import { api, errorMessage } from "../lib/api";
import { type DriveItem, type DrivePage, formatBytes, driveSize } from "../lib/drive";
import { Button, Icon, Input, SearchField, Tabs } from "./ui";
import { LoadingSkeleton } from "./loading-skeleton";
import { WorkspaceNotice } from "./workspace-dialog";

export function DriveFilePicker({
  onChoose,
  busy,
}: {
  onChoose: (item: DriveItem) => void;
  busy: boolean;
}) {
  const request = useRef<AbortController | null>(null);
  const [scope, setScope] = useState("my"),
    [path, setPath] = useState<{ id: string; name: string }[]>([]),
    [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [items, setItems] = useState<DriveItem[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const parent = path.at(-1)?.id;
  const params = new URLSearchParams({ view: scope, sort: "name", order: "asc", limit: "50" });
  if (search) params.set("q", search);
  else if (parent) params.set("parent_id", parent);
  else if (scope === "my") params.set("parent_id", "root");
  const url = `/api/drive/items?${params}`;
  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    setItems([]);
    setCursor(null);
    void api<DrivePage>(url, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) {
          setItems(data.items);
          setCursor(data.next_cursor);
        }
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [url]);
  const more = async () => {
    const controller = request.current;
    if (!cursor || loading || !controller || controller.signal.aborted) return;
    setLoading(true);
    setError("");
    try {
      const data = await api<DrivePage>(`${url}&cursor=${encodeURIComponent(cursor)}`, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setItems((old) => [
        ...new Map([...old, ...data.items].map((item) => [item.id, item])).values(),
      ]);
      setCursor(data.next_cursor);
    } catch (failure) {
      if (!controller.signal.aborted) setError(errorMessage(failure));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };
  return (
    <div className="drive-file-picker">
      <Tabs.Root
        value={scope}
        onValueChange={(value) => {
          setScope(String(value));
          setPath([]);
          setSearch("");
          setQuery("");
        }}
      >
        <Tabs.List aria-label={t("editorFiles.driveLocation")}>
          <Tabs.Tab value="my" disabled={busy}>
            {t("componentsDriveDialogs.myDrive")}
          </Tabs.Tab>
          <Tabs.Tab value="shared" disabled={busy}>
            {t("componentsDriveDialogs.sharedFolders")}
          </Tabs.Tab>
        </Tabs.List>
      </Tabs.Root>
      <SearchField
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(query.trim());
        }}
      >
        <Icon name="search" />
        <Input
          type="text"
          variant="integrated"
          aria-label={t("editorFiles.searchDrive")}
          placeholder={t("editorFiles.searchDrive")}
          value={query}
          maxLength={255}
          disabled={busy}
          onChange={(event) => setQuery(event.target.value)}
        />
        {(query || search) && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("componentsDriveChrome.clearSearch")}
            disabled={busy}
            onClick={() => {
              setQuery("");
              setSearch("");
            }}
          >
            <Icon name="close" />
          </Button>
        )}
      </SearchField>
      <nav className="wiki-file-breadcrumb" aria-label={t("editorFiles.driveLocation")}>
        <Button
          variant="text"
          size="sm"
          disabled={busy}
          onClick={() => {
            setPath([]);
            setSearch("");
            setQuery("");
          }}
        >
          {t(
            scope === "my"
              ? "componentsDriveDialogs.myDrive"
              : "componentsDriveDialogs.sharedFolders",
          )}
        </Button>
        {path.map((folder, index) => (
          <Button
            key={folder.id}
            variant="text"
            size="sm"
            disabled={busy}
            onClick={() => {
              setPath(path.slice(0, index + 1));
              setSearch("");
              setQuery("");
            }}
          >
            {folder.name}
          </Button>
        ))}
      </nav>
      <div className="wiki-file-list" aria-busy={loading}>
        {loading && !items.length && <LoadingSkeleton kind="list" rows={3} />}
        {items.map((item) => (
          <Button
            key={item.id}
            variant="ghost"
            disabled={busy}
            onClick={() => {
              if (item.kind === "folder") {
                setPath((old) => [...old, { id: item.id, name: item.name }]);
                setSearch("");
                setQuery("");
              } else onChoose(item);
            }}
          >
            <Icon name={item.kind === "folder" ? "folder" : "file"} />
            <span>{item.name}</span>
            {item.kind === "folder" ? (
              <Icon name="chevron" />
            ) : (
              <small>{formatBytes(driveSize(item))}</small>
            )}
          </Button>
        ))}
        {!loading && !items.length && !error && <p>{t("editorFiles.noFiles")}</p>}
      </div>
      <WorkspaceNotice error={error} />
      {cursor && (
        <Button disabled={busy || loading} onClick={() => void more()}>
          {t("wiki.loadMore")}
        </Button>
      )}
    </div>
  );
}
