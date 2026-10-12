import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import {
  Button,
  Icon,
  OfficeflareMark,
  Toggle,
  ToggleGroup,
} from "../components/ui";
import {
  DriveField,
  DriveFileIcon,
  DriveIconButton,
  DriveNotice,
  driveFailure,
} from "../components/drive-controls";
import {
  DrivePreview,
  downloadDriveItem,
  type DriveContentLoader,
} from "../components/drive-preview";
import { ApiError } from "../lib/api";
import {
  driveDate,
  driveSize,
  fileKind,
  formatBytes,
  type DriveItem,
  type DrivePage,
} from "../lib/drive";
import "./drive.css";

export function PublicDrivePage() {
  const { token = "" } = useParams(),
    base = `/api/drive/public/${token}`;
  const [password, setPassword] = useState(""),
    [draft, setDraft] = useState(""),
    [attempt, setAttempt] = useState(0),
    [needsPassword, setNeedsPassword] = useState(false),
    [root, setRoot] = useState<DriveItem | null>(null),
    [allow, setAllow] = useState(false),
    [expires, setExpires] = useState<number | null>(null);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [passwordError, setPasswordError] = useState(""),
    [trail, setTrail] = useState<DriveItem[]>([]),
    [items, setItems] = useState<DriveItem[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [more, setMore] = useState(false),
    [layout, setLayout] = useState("list"),
    [preview, setPreview] = useState<DriveItem | null>(null);
  const loader = useCallback<DriveContentLoader>(
    async (path, signal) => {
      const response = await fetch(path, {
        credentials: "omit",
        cache: "no-store",
        signal,
        headers: password ? { "X-Drive-Link-Password": password } : {},
      });
      if (!response.ok) {
        let message = "Unable to open this shared item.";
        try {
          const body = (await response.json()) as { error: string };
          if (response.status < 500) message = body.error;
        } catch {
          /* Generic error for non-JSON responses. */
        }
        throw new ApiError(response.status, message);
      }
      return response;
    },
    [password],
  );
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setRoot(null);
    setTrail([]);
    setItems([]);
    setPreview(null);
    document.title = "Shared with you · Officeflare";
    const referrer = document.createElement("meta");
    referrer.name = "referrer";
    referrer.content = "no-referrer";
    document.head.append(referrer);
    void loader(base, controller.signal)
      .then(
        (response) =>
          response.json() as Promise<{
            item: DriveItem;
            allow_download: boolean;
            expires_at: number | null;
          }>,
      )
      .then((data) => {
        if (!controller.signal.aborted) {
          setRoot(data.item);
          setAllow(data.allow_download);
          setExpires(data.expires_at);
          setTrail([data.item]);
          setNeedsPassword(false);
          setPasswordError("");
          setLoading(false);
          document.title = `${data.item.name} · Shared · Officeflare`;
        }
      })
      .catch((failure) => {
        if (controller.signal.aborted) return;
        setLoading(false);
        if (failure instanceof ApiError && failure.status === 403) {
          setNeedsPassword(true);
          setPasswordError(
            password ? "That password did not work. Try again." : "",
          );
        } else {
          setNeedsPassword(false);
          setError(
            failure instanceof ApiError && failure.status === 404
              ? "This link has expired, was revoked, or is no longer available."
              : driveFailure(failure),
          );
        }
      });
    return () => {
      controller.abort();
      referrer.remove();
    };
  }, [base, loader, attempt]);
  const parent = trail.at(-1);
  useEffect(() => {
    if (!parent || parent.kind !== "folder") return;
    const controller = new AbortController();
    setLoading(true);
    setItems([]);
    setError("");
    setCursor(null);
    void loader(
      `${base}/items?parent_id=${parent.id}&limit=100`,
      controller.signal,
    )
      .then((response) => response.json() as Promise<DrivePage>)
      .then((data) => {
        if (!controller.signal.aborted) {
          setItems(data.items);
          setCursor(data.next_cursor);
          setLoading(false);
        }
      })
      .catch((failure) => {
        if (!controller.signal.aborted) {
          setError(driveFailure(failure));
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [parent?.id, base, loader]);
  const open = (item: DriveItem) =>
    item.kind === "folder"
      ? setTrail((old) => [...old, item])
      : setPreview(item);
  const download = (item: DriveItem) => {
    setError("");
    void downloadDriveItem(
      item,
      `${base}/items/${item.id}/content`,
      loader,
    ).catch((failure) => setError(driveFailure(failure)));
  };
  const loadMore = async () => {
    if (!cursor || !parent) return;
    setMore(true);
    try {
      const data = (await (
        await loader(
          `${base}/items?parent_id=${parent.id}&limit=100&cursor=${encodeURIComponent(cursor)}`,
          new AbortController().signal,
        )
      ).json()) as DrivePage;
      setItems((old) => [...old, ...data.items]);
      setCursor(data.next_cursor);
    } catch (failure) {
      setError(driveFailure(failure));
    } finally {
      setMore(false);
    }
  };
  return (
    <main data-ui-theme="neutral" className="drive-public-shell">
      <header className="drive-public-topbar">
        <Link to="/" className="drive-public-brand">
          <OfficeflareMark />
          Officeflare<span className="drive-muted">/ Shared files</span>
        </Link>
        <Link to="/login">Sign in to workspace</Link>
      </header>
      <section className="drive-public-frame">
        {needsPassword ? (
          <div className="drive-public-password">
            <span className="drive-link-symbol" style={{ margin: "0 auto" }}>
              <Icon name="shield" width="26" height="26" />
            </span>
            <h1>This link is protected</h1>
            <p>
              Enter the password provided by the owner to view the shared files.
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                setPassword(draft);
                setAttempt((value) => value + 1);
              }}
            >
              <DriveField
                label="Link password"
                type="password"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                autoFocus
                required
                autoComplete="off"
                maxLength={128}
              />
              <DriveNotice error={passwordError} />
              <Button
                type="submit"
                variant="primary"
                disabled={loading || !draft}
              >
                {loading ? "Checking…" : "Open shared files"}
                <Icon name="arrow" />
              </Button>
            </form>
          </div>
        ) : !root ? (
          <div className="drive-state">
            <Icon name={error ? "link" : "drive"} width="40" height="40" />
            <h2>{loading ? "Opening shared files…" : "Link unavailable"}</h2>
            <p role={error ? "alert" : "status"}>
              {error || "Checking access to this share link."}
            </p>
            {error && (
              <Button onClick={() => setAttempt((value) => value + 1)}>
                Try again
              </Button>
            )}
          </div>
        ) : root.kind === "file" ? (
          <div className="drive-public-file">
            <DriveFileIcon item={root} large />
            <h1>{root.name}</h1>
            <p>
              {fileKind(root).label} · {formatBytes(driveSize(root))}
            </p>
            <div>
              <Button onClick={() => setPreview(root)}>
                <Icon name="eye" />
                View file
              </Button>
              {allow && (
                <Button variant="primary" onClick={() => download(root)}>
                  <Icon name="download" />
                  Download
                </Button>
              )}
            </div>
            {!allow && <p>Preview and downloads are disabled by the owner.</p>}
            <DriveNotice error={error} />
          </div>
        ) : (
          <div className="drive-content-pane">
            <header className="drive-page-header">
              <div>
                <nav
                  className="drive-breadcrumbs"
                  aria-label="Shared folder path"
                >
                  {trail.map((item, index) => (
                    <span key={item.id}>
                      {index > 0 && (
                        <Icon name="chevron" width="12" height="12" />
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setTrail((old) => old.slice(0, index + 1))
                        }
                      >
                        {item.name}
                      </Button>
                    </span>
                  ))}
                </nav>
                <h1>{parent?.name}</h1>
              </div>
              <ToggleGroup
                value={[layout]}
                onValueChange={(values) => {
                  if (values[0]) setLayout(values[0]);
                }}
                className="drive-layout-toggle"
                aria-label="Shared file view"
              >
                <Toggle value="list" data-size="icon"
                  aria-label="List view"
                >
                  <Icon name="list" />
                </Toggle>
                <Toggle value="grid" data-size="icon"
                  aria-label="Grid view"
                >
                  <Icon name="grid" />
                </Toggle>
              </ToggleGroup>
            </header>
            <div className="drive-public-viewer-note">
              <Icon name="eye" />
              Shared with you · View only
              {!allow && " · Preview and downloads disabled"}
              {expires && ` · Expires ${driveDate(expires)}`}
            </div>
            <div className={`drive-public-table drive-layout-${layout}`}>
              {loading && (
                <p className="drive-state" role="status">
                  Loading shared files…
                </p>
              )}
              <DriveNotice error={error} />
              {!loading && !items.length && !error && (
                <div className="drive-empty">
                  <Icon name="folder" width="46" height="46" />
                  <h2>This folder is empty</h2>
                  <p>Files added by the owner will appear here.</p>
                </div>
              )}
              {!!items.length && (
                <div
                  role="grid"
                  className="drive-file-grid"
                  aria-label="Shared files"
                >
                  <div className="drive-table-header" role="row">
                    <div role="columnheader">Name</div>
                    <div role="columnheader">Last modified</div>
                    <div role="columnheader">File size</div>
                    <div role="columnheader">
                      <span className="visually-hidden">Download</span>
                    </div>
                  </div>
                  {items.map((item) => (
                    <div
                      className="drive-file-row"
                      role="row"
                      key={item.id}
                      tabIndex={0}
                      onDoubleClick={() => open(item)}
                      onKeyDown={(event) => {
                        if (
                          event.target === event.currentTarget &&
                          event.key === "Enter"
                        )
                          open(item);
                      }}
                    >
                      <div className="drive-row-name" role="gridcell">
                        <DriveFileIcon item={item} />
                        <Button variant="text"
                          className="drive-name-button"
                          title={item.name}
                          onClick={() => open(item)}
                        >
                          {item.name}
                        </Button>
                      </div>
                      {item.kind === "file" && (
                        <div className="drive-card-preview" aria-hidden="true">
                          <DriveFileIcon item={item} large />
                          <span>{fileKind(item).label}</span>
                        </div>
                      )}
                      <div className="drive-row-date" role="gridcell">
                        {driveDate(item.updated_at)}
                      </div>
                      <div className="drive-row-size" role="gridcell">
                        {item.kind === "folder"
                          ? "—"
                          : formatBytes(driveSize(item))}
                      </div>
                      <div className="drive-row-menu" role="gridcell">
                        {allow && item.kind === "file" && (
                          <DriveIconButton
                            icon="download"
                            label={`Download ${item.name}`}
                            onClick={() => download(item)}
                          />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {cursor && (
                <div className="drive-load-more">
                  <Button disabled={more} onClick={() => void loadMore()}>
                    {more ? "Loading…" : "Load more files"}
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}
        <footer className="drive-public-footer">
          <Icon name="shield" width="11" height="11" /> Shared securely with
          Officeflare
          {root && root.kind === "file" && expires
            ? ` · Expires ${driveDate(expires)}`
            : ""}
        </footer>
      </section>
      {preview && (
        <DrivePreview
          item={preview}
          onClose={() => setPreview(null)}
          loader={loader}
          basePath={`${base}/items/${preview.id}`}
          canDownload={allow}
        />
      )}
    </main>
  );
}
