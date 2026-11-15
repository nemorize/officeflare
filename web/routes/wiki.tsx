import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useBlocker, useNavigate, useSearchParams } from "react-router";
import { t } from "../../shared/i18n/index.ts";
import { wikiRoles, type WikiComment, type WikiPage as Page } from "../../shared/wiki";
import { api, errorMessage } from "../lib/api";
import type { CollaborationClient, CollaborationTransport } from "../lib/collaboration/client";
import { useWiki } from "../components/wiki-context";
import {
  WikiDialog,
  WikiPageIcon,
  WikiPageHeader,
  WikiSidePanel,
} from "../components/wiki-controls";
import { WikiRevisionPreview } from "../components/wiki-revision-preview";
import { WikiHome, WikiPageTable } from "../components/wiki-home";
import { formatDateTime } from "../lib/regional";
import { Confirm } from "../components/console-shared";
import { useAccount } from "../components/account-context";
import { CollaborativeEditor, downloadText } from "../components/collaborative-editor";
import {
  Button,
  Icon,
  Input,
  Menu,
  MenuPopup,
  SelectControl,
  Textarea,
  Popover,
  PopoverPopup,
} from "../components/ui";
import "./wiki.css";

const transport: CollaborationTransport = {
  session: (resource) =>
    api(`/api/collaboration/resources/${resource}/sessions`, { method: "POST" }),
  socketUrl: (resource) => {
    const url = new URL(`/api/collaboration/resources/${resource}/sync`, location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.href;
  },
};
type Member = { user_id: string; email_address: string; display_name: string | null; role: string };
type Asset = { id: string; filename: string; byte_size: number; content_type: string };
const roleName = (role: string) =>
  role === "owner"
    ? t("wiki.owner")
    : wikiRoles.includes(role as (typeof wikiRoles)[number])
      ? t(`wiki.${role as (typeof wikiRoles)[number]}`)
      : t("wiki.none");

function Members() {
  const wiki = useWiki(),
    [members, setMembers] = useState<Member[]>([]),
    [version, setVersion] = useState(0),
    [email, setEmail] = useState(""),
    [role, setRole] = useState("viewer"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!wiki.space) return;
    const result = await api<{ members: Member[]; version: number }>(
      `/api/wiki/spaces/${wiki.space.id}/members`,
    );
    setMembers(result.members);
    setVersion(result.version);
  }, [wiki.space?.id]);
  useEffect(() => {
    void load().catch((e) => setError(errorMessage(e)));
  }, [load]);
  const change = async (member?: Member, nextRole?: string) => {
    if (!wiki.space) return;
    setBusy(true);
    setError("");
    try {
      if (member && !nextRole)
        await api(
          `/api/wiki/spaces/${wiki.space.id}/members/${member.user_id}?version=${version}`,
          { method: "DELETE" },
        );
      else
        await api(`/api/wiki/spaces/${wiki.space.id}/members`, {
          method: "PUT",
          body: { email: member?.email_address ?? email, role: nextRole ?? role, version },
        });
      setEmail("");
      await load();
      wiki.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="wiki-settings">
      <h1>{t("wiki.members")}</h1>
      {error && (
        <p role="alert" className="wiki-error">
          {error}
        </p>
      )}
      {wiki.can("sharing.internal") && wiki.space?.kind !== "personal" && (
        <form
          className="wiki-member-form"
          onSubmit={(e) => {
            e.preventDefault();
            void change();
          }}
        >
          <Input
            type="email"
            aria-label={t("wiki.email")}
            placeholder={t("wiki.email")}
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <SelectControl
            aria-label={t("wiki.role")}
            value={role}
            onValueChange={setRole}
            options={wikiRoles.map((value) => ({ value, label: roleName(value) }))}
          />
          <Button type="submit" disabled={busy}>
            {t("wiki.addMember")}
          </Button>
        </form>
      )}
      <ul className="wiki-members">
        {members.map((member) => (
          <li key={member.user_id}>
            <div>
              <strong>{member.display_name || member.email_address}</strong>
              <small>{member.email_address}</small>
            </div>
            {member.role !== "owner" && wiki.can("sharing.internal") ? (
              <SelectControl
                aria-label={`${member.email_address} ${t("wiki.role")}`}
                disabled={busy}
                value={member.role}
                onValueChange={(value) => void change(member, value)}
                options={wikiRoles.map((value) => ({ value, label: roleName(value) }))}
              />
            ) : (
              <span className="wiki-role-label">{roleName(member.role)}</span>
            )}
            {member.role !== "owner" && wiki.can("sharing.internal") && (
              <Button variant="ghost" disabled={busy} onClick={() => void change(member)}>
                {t("wiki.remove")}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
function PageList({ view, query = "" }: { view: string; query?: string }) {
  const wiki = useWiki(),
    [pages, setPages] = useState<Page[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0),
    [loading, setLoading] = useState(true),
    [cursor, setCursor] = useState<string | null>(null),
    [removing, setRemoving] = useState<Page | null>(null);
  const request = useRef<AbortController | null>(null);
  const filter =
    view === "search"
      ? `q=${encodeURIComponent(query)}`
      : view === "trash"
        ? "trash=true"
        : "favorites=true";
  const projection =
    view === "search"
      ? wiki.pages
          .map((page) => `${page.id}:${page.projected_epoch}:${page.projected_seq}:${page.role}`)
          .join("|")
      : "";
  useEffect(() => {
    if (!wiki.space) return;
    const abort = new AbortController();
    request.current = abort;
    setBusy(false);
    setLoading(true);
    setError("");
    setPages([]);
    setCursor(null);
    void api<{ pages: Page[]; next_cursor: string | null }>(
      `/api/wiki/spaces/${wiki.space.id}/pages?${filter}`,
      { signal: abort.signal },
    )
      .then((result) => {
        if (!abort.signal.aborted) {
          setPages(result.pages);
          setCursor(result.next_cursor);
        }
      })
      .catch((failure) => {
        if (!abort.signal.aborted) setError(errorMessage(failure));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [wiki.space?.id, filter, revision, projection]);
  const more = async () => {
    const controller = request.current;
    if (!wiki.space || !cursor || busy || !controller || controller.signal.aborted) return;
    setBusy(true);
    try {
      const result = await api<{ pages: Page[]; next_cursor: string | null }>(
        `/api/wiki/spaces/${wiki.space.id}/pages?${filter}&cursor=${encodeURIComponent(cursor)}`,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setPages((previous) => [...previous, ...result.pages]);
      setCursor(result.next_cursor);
    } catch (failure) {
      if (!controller.signal.aborted) setError(errorMessage(failure));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const change = async (page: Page, remove = false) => {
    setBusy(true);
    setError("");
    try {
      await api(`/api/wiki/pages/${page.id}${remove ? `?version=${page.version}` : "/restore"}`, {
        method: remove ? "DELETE" : "POST",
        ...(remove ? {} : { body: { version: page.version } }),
      });
      setRevision((v) => v + 1);
      wiki.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="wiki-settings">
      <h1>
        {t(
          view === "search"
            ? "wiki.searchResults"
            : view === "trash"
              ? "wiki.trash"
              : "wiki.favorites",
        )}
      </h1>
      {view === "search" && <p className="wiki-muted">{query}</p>}
      {view === "trash" && <p>{t("wiki.trashHint")}</p>}
      {error && (
        <p role="alert" className="wiki-error">
          {error}
        </p>
      )}
      {!!pages.length && (
        <WikiPageTable
          pages={pages}
          trash={view === "trash"}
          actions={
            view === "trash" && wiki.can("pages.delete")
              ? (page) => (
                  <>
                    <Button disabled={busy} onClick={() => void change(page)}>
                      {t("wiki.restore")}
                    </Button>
                    {wiki.space!.role >= 4 && (
                      <Button variant="ghost" disabled={busy} onClick={() => setRemoving(page)}>
                        {t("wiki.deleteForever")}
                      </Button>
                    )}
                  </>
                )
              : undefined
          }
        />
      )}
      {loading ? (
        <p className="wiki-muted" role="status">
          {t("wiki.loading")}
        </p>
      ) : (
        !pages.length &&
        !error && (
          <div className="wiki-list-empty">
            <Icon name={view === "search" ? "search" : view === "trash" ? "trash" : "star"} />
            <h2>
              {t(
                view === "search"
                  ? "wiki.noResults"
                  : view === "trash"
                    ? "wiki.emptyTrash"
                    : "wiki.noFavorites",
              )}
            </h2>
          </div>
        )
      )}
      {cursor && (
        <Button disabled={busy} onClick={() => void more()}>
          {t("wiki.loadMore")}
        </Button>
      )}
      {removing && (
        <Confirm
          open
          title={t("wiki.deleteForever")}
          description={t("wiki.confirmDelete")}
          label={t("wiki.deleteForever")}
          destructive
          onClose={() => setRemoving(null)}
          onConfirm={() => change(removing, true)}
        />
      )}
    </section>
  );
}
function Share({ page, onClose }: { page: Page; onClose: () => void }) {
  const wiki = useWiki(),
    [members, setMembers] = useState<Member[]>([]),
    [grants, setGrants] = useState<Record<string, string>>({}),
    [mode, setMode] = useState("inherit"),
    [version, setVersion] = useState(0),
    [aclVersion, setAclVersion] = useState(0),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    void Promise.all([
      api<{ members: Member[] }>(`/api/wiki/spaces/${page.space_id}/people`, {
        signal: abort.signal,
      }),
      api<{ grants: Member[]; permission_mode: string; version: number; acl_version: number }>(
        `/api/wiki/pages/${page.id}/grants`,
        { signal: abort.signal },
      ),
    ])
      .then(([people, current]) => {
        if (abort.signal.aborted) return;
        setMembers(people.members);
        setGrants(Object.fromEntries(current.grants.map((g) => [g.user_id, g.role])));
        setMode(current.permission_mode);
        setVersion(current.version);
        setAclVersion(current.acl_version);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(errorMessage(e));
      });
    return () => abort.abort();
  }, [page.id, page.space_id]);
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await api(`/api/wiki/pages/${page.id}/grants`, {
        method: "PUT",
        body: {
          permission_mode: mode,
          version,
          acl_version: aclVersion,
          grants: Object.entries(grants)
            .filter(([, role]) => role)
            .map(([user_id, role]) => ({ user_id, role })),
        },
      });
      wiki.refresh();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Popover.Title>{t("wiki.share")}</Popover.Title>
      <ul className="wiki-members">
        {members.map((member) => (
          <li key={member.user_id}>
            <span>{member.display_name || member.email_address}</span>
            {member.role === "owner" || member.role === "manager" ? (
              <span className="wiki-role-label">{roleName(member.role)}</span>
            ) : (
              <SelectControl
                aria-label={`${member.email_address} ${t("wiki.role")}`}
                value={grants[member.user_id] ?? ""}
                disabled={busy}
                onValueChange={(value) => setGrants((old) => ({ ...old, [member.user_id]: value }))}
                options={[
                  { value: "", label: t("wiki.none") },
                  ...wikiRoles.map((value) => ({ value, label: roleName(value) })),
                ]}
              />
            )}
          </li>
        ))}
      </ul>
      <div className="wiki-share-section">
        <h3>{t("wiki.generalAccess")}</h3>
        <SelectControl
          aria-label={t("wiki.share")}
          value={mode}
          disabled={!version || busy}
          onValueChange={setMode}
          options={[
            { value: "inherit", label: t("wiki.inherit") },
            { value: "restricted", label: t("wiki.restricted") },
          ]}
        />
        <p className="wiki-muted">{t("wiki.restrictionHint")}</p>
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="wiki-share-footer">
        <Button
          variant="ghost"
          onClick={() =>
            void (navigator.clipboard?.writeText(location.href) ?? Promise.reject()).catch(() =>
              setError(t("wiki.copyLinkFailed")),
            )
          }
        >
          <Icon name="link" />
          {t("wiki.copyLink")}
        </Button>
        <Button variant="primary" onClick={() => void save()} disabled={busy || !version}>
          {t("wiki.save")}
        </Button>
      </div>
    </>
  );
}
function History({
  page,
  client,
  onClose,
  onPreview,
}: {
  page: Page;
  client: CollaborationClient | null;
  onClose: () => void;
  onPreview: (state: string | null) => void;
}) {
  const wiki = useWiki(),
    [revisions, setRevisions] = useState<
      { id: string; epoch: number; seq: number; created_at: number }[]
    >([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [restoring, setRestoring] = useState<string | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!selected) {
      setPreview(null);
      return;
    }
    const abort = new AbortController();
    setPreview(null);
    onPreview(null);
    setError("");
    void api<{ state: string }>(
      `/api/collaboration/resources/${page.resource_id}/snapshots/${selected}`,
      { signal: abort.signal },
    )
      .then((data) => {
        if (!abort.signal.aborted) {
          setPreview(data.state);
          onPreview(data.state);
        }
      })
      .catch((failure) => {
        if (!abort.signal.aborted) setError(errorMessage(failure));
      });
    return () => {
      abort.abort();
      onPreview(null);
    };
  }, [selected, page.resource_id, onPreview]);
  const load = useCallback(async () => {
    const result = await api<{ revisions: typeof revisions }>(
      `/api/collaboration/resources/${page.resource_id}/snapshots`,
    );
    setRevisions(result.revisions);
  }, [page.resource_id]);
  useEffect(() => {
    void load().catch((e) => setError(errorMessage(e)));
  }, [load]);
  const change = async (snapshot?: string) => {
    setBusy(true);
    setError("");
    try {
      if (snapshot) {
        await api(`/api/collaboration/resources/${page.resource_id}/restores`, {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: { snapshot_id: snapshot, epoch: client?.epoch ?? page.projected_epoch },
        });
        onClose();
      } else {
        await api(`/api/collaboration/resources/${page.resource_id}/snapshots`, { method: "POST" });
        await load();
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <WikiSidePanel title={t("wiki.history")} onClose={onClose}>
      {error && <p role="alert">{error}</p>}
      {wiki.can("pages.update") && (
        <Button
          className="wiki-checkpoint"
          disabled={busy || !!client?.unsaved}
          onClick={() => void change()}
        >
          {t("wiki.checkpoint")}
        </Button>
      )}
      <ul className="wiki-members">
        {revisions.map((revision) => (
          <li key={revision.id}>
            <Button
              variant="ghost"
              className="wiki-revision-choice"
              aria-pressed={selected === revision.id}
              onClick={() => setSelected(revision.id)}
            >
              <Icon name="clock" />
              <time dateTime={new Date(revision.created_at).toISOString()}>
                {formatDateTime(revision.created_at / 1000)}
              </time>
            </Button>
            {wiki.can("history.restore") && (
              <Button
                disabled={busy || !client?.epoch || !!client?.unsaved}
                onClick={() => setRestoring(revision.id)}
              >
                {t("wiki.restore")}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {selected && !preview && !error && (
        <p className="wiki-muted" role="status">
          {t("wiki.loading")}
        </p>
      )}
      {selected && preview && (
        <div className="wiki-history-mobile-preview">
          <Button variant="ghost" onClick={() => setSelected(null)}>
            <Icon name="chevron" className="wiki-back-icon" />
            {t("wiki.history")}
          </Button>
          <WikiRevisionPreview state={preview} />
          {wiki.can("history.restore") && (
            <Button
              disabled={busy || !client?.epoch || !!client?.unsaved}
              onClick={() => setRestoring(selected)}
            >
              {t("wiki.restore")}
            </Button>
          )}
        </div>
      )}
      {restoring && (
        <Confirm
          open
          title={t("wiki.restore")}
          description={t("wiki.confirmRestore")}
          label={t("wiki.restore")}
          onClose={() => setRestoring(null)}
          onConfirm={() => change(restoring)}
        />
      )}
    </WikiSidePanel>
  );
}
function Move({ page, onClose }: { page: Page; onClose: () => void }) {
  const wiki = useWiki(),
    [parent, setParent] = useState(page.parent_id ?? ""),
    [query, setQuery] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const descendants = new Set([page.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of wiki.pages)
      if (p.parent_id && descendants.has(p.parent_id) && !descendants.has(p.id)) {
        descendants.add(p.id);
        changed = true;
      }
  }
  const save = async () => {
    setBusy(true);
    try {
      await api(`/api/wiki/pages/${page.id}/moves`, {
        method: "POST",
        body: { parent_id: parent || null, version: page.version },
      });
      wiki.refresh();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <WikiDialog title={t("wiki.move")} open onClose={onClose}>
      <Input
        autoFocus
        type="search"
        aria-label={t("wiki.parent")}
        placeholder={t("wiki.search")}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="wiki-move-destinations" role="listbox" aria-label={t("wiki.parent")}>
        {wiki.space!.role >= 4 && !query && (
          <button role="option" aria-selected={!parent} onClick={() => setParent("")}>
            <Icon name="book" />
            {wiki.space!.name}
            <small>{t("wiki.root")}</small>
            {!parent && <Icon name="check" />}
          </button>
        )}
        {wiki.pages
          .filter(
            (p) =>
              !descendants.has(p.id) &&
              p.role >= 4 &&
              (p.title || t("wiki.untitled")).toLowerCase().includes(query.toLowerCase()),
          )
          .map((p) => (
            <button
              key={p.id}
              role="option"
              aria-selected={parent === p.id}
              onClick={() => setParent(p.id)}
            >
              <span>{p.icon || <Icon name="file" />}</span>
              <span>{p.title || t("wiki.untitled")}</span>
              {parent === p.id && <Icon name="check" />}
            </button>
          ))}
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="wiki-dialog-actions">
        <Button disabled={busy} onClick={() => void save()}>
          {t("wiki.move")}
        </Button>
      </div>
    </WikiDialog>
  );
}
function Discussion({ page, comments = false }: { page: Page; comments?: boolean }) {
  const account = useAccount();
  const uploadInput = useRef<HTMLInputElement>(null);
  const wiki = useWiki(),
    [entries, setComments] = useState<WikiComment[]>([]),
    [assets, setAssets] = useState<Asset[]>([]),
    [draft, setDraft] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    if (comments) {
      const data = await api<{ comments: WikiComment[] }>(`/api/wiki/pages/${page.id}/comments`);
      setComments(data.comments);
    } else {
      const data = await api<{ assets: Asset[] }>(`/api/wiki/pages/${page.id}/assets`);
      setAssets(data.assets);
    }
  }, [page.id, comments]);
  useEffect(() => {
    let active = true;
    const run = () =>
      void load().catch((e) => {
        if (active) setError(errorMessage(e));
      });
    run();
    const timer = setInterval(run, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [load]);
  const post = async () => {
    setBusy(true);
    try {
      await api(`/api/wiki/pages/${page.id}/comments`, { method: "POST", body: { body: draft } });
      setDraft("");
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const attach = async (file: File) => {
    setBusy(true);
    try {
      await api(`/api/wiki/pages/${page.id}/assets?filename=${encodeURIComponent(file.name)}`, {
        method: "POST",
        body: file,
      });
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const download = async (asset: Asset) => {
    try {
      const blob = await api<Blob>(`/api/wiki/pages/${page.id}/assets/${asset.id}`, {
        response: "blob",
      });
      const url = URL.createObjectURL(blob),
        a = document.createElement("a");
      a.href = url;
      a.download = asset.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const resolve = async (comment: WikiComment) => {
    try {
      await api(`/api/wiki/pages/${page.id}/comments/${comment.id}`, {
        method: "PATCH",
        body: { resolved: !comment.resolved_at, version: comment.version },
      });
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <div className={`wiki-discussion ${comments ? "is-comments" : ""}`}>
      {error && (
        <p role="alert" className="wiki-error">
          {error}
        </p>
      )}
      {!comments && (
        <>
          <div className="wiki-section-heading">
            <h2>{t("wiki.attachments")}</h2>
            {page.role >= 3 && wiki.can("assets.upload") && (
              <>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => uploadInput.current?.click()}
                >
                  <Icon name="attachment" />
                  {t("wiki.attach")}
                </Button>
                <input
                  ref={uploadInput}
                  type="file"
                  hidden
                  disabled={busy}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void attach(file);
                    event.target.value = "";
                  }}
                />
              </>
            )}
          </div>
          <ul className="wiki-assets">
            {assets.map((asset) => (
              <li key={asset.id}>
                <Button variant="ghost" onClick={() => void download(asset)}>
                  <Icon name="file" />
                  {asset.filename}
                  <small>{t("wiki.fileSize", { size: Math.ceil(asset.byte_size / 1024) })}</small>
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
      {comments && (
        <>
          <ul className="wiki-comments">
            {entries.map((comment) => (
              <li key={comment.id} className={comment.resolved_at ? "is-resolved" : ""}>
                <div>
                  <strong>{comment.author_name}</strong>
                  <time>{new Date(comment.created_at * 1000).toLocaleString()}</time>
                </div>
                <p>{comment.body}</p>
                {(page.role >= 4 || comment.author_user_id === account.user?.id) &&
                  wiki.can("comments.create") && (
                    <Button variant="ghost" size="sm" onClick={() => void resolve(comment)}>
                      {t(comment.resolved_at ? "wiki.reopen" : "wiki.resolve")}
                    </Button>
                  )}
              </li>
            ))}
          </ul>
          {page.role >= 2 && wiki.can("comments.create") && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void post();
              }}
            >
              <Textarea
                aria-label={t("wiki.comments")}
                placeholder={t("wiki.commentPlaceholder")}
                value={draft}
                maxLength={10000}
                onChange={(event) => setDraft(event.target.value)}
              />
              <Button type="submit" disabled={busy || !draft.trim()}>
                {t("wiki.post")}
              </Button>
            </form>
          )}
        </>
      )}
    </div>
  );
}
function OpenPage({ page }: { page: Page }) {
  const wiki = useWiki(),
    navigate = useNavigate(),
    [params, setParams] = useSearchParams(),
    [panel, setPanel] = useState<"share" | "history" | "move" | "comments" | null>(null),
    [error, setError] = useState(""),
    [client, setClient] = useState<CollaborationClient | null>(null),
    [statusContainer, setStatusContainer] = useState<HTMLDivElement | null>(null),
    [revisionState, setRevisionState] = useState<string | null>(null),
    [, render] = useState(0);
  useEffect(() => client?.subscribe(() => render((v) => v + 1)), [client]);
  useEffect(() => {
    if (page.role === 0) setPanel(null);
  }, [page.role]);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      !!client?.unsaved &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search),
  );
  const updateTitle = useCallback(
    (title: string) => wiki.updateTitle(page.id, title),
    [wiki.updateTitle, page.id],
  );
  const trash = async () => {
    try {
      await api(`/api/wiki/pages/${page.id}/trash`, {
        method: "POST",
        body: { version: page.version },
      });
      wiki.refresh();
      navigate(`/wiki/${page.space_id}`);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const favorite = async () => {
    try {
      await api(`/api/wiki/pages/${page.id}/favorite`, {
        method: page.favorite ? "DELETE" : "PUT",
      });
      wiki.refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const exportPage = async () => {
    try {
      const content = await api<Blob>(`/api/wiki/pages/${page.id}/export`, { response: "blob" });
      downloadText(`${page.title || t("wiki.untitled")}.txt`, await content.text());
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  useEffect(() => {
    if (!client?.synced || !params.has("action")) return;
    const action = params.get("action");
    if (action === "move" && page.role >= 4 && wiki.can("pages.move")) setPanel("move");
    if (action === "rename" && page.role >= 3 && wiki.can("pages.update")) {
      const title = document.querySelector<HTMLTextAreaElement>(".wiki-title");
      title?.focus();
      title?.select();
    }
    if (action === "trash" && client.unsaved) return;
    if (action === "trash" && page.role >= 3 && wiki.can("pages.delete")) {
      void trash();
    }
    const next = new URLSearchParams(params);
    next.delete("action");
    setParams(next, { replace: true });
  }, [client?.synced, client?.unsaved, params, page.role]);
  const [copied, setCopied] = useState(false);
  const ancestors: Page[] = [];
  let parent = page.parent_id;
  while (parent && ancestors.length < 32) {
    const entry = wiki.pages.find((p) => p.id === parent);
    if (!entry) break;
    ancestors.unshift(entry);
    parent = entry.parent_id;
  }
  return (
    <article
      className={`wiki-page ${panel === "history" || panel === "comments" ? "has-side-panel" : ""}`}
    >
      <WikiPageHeader>
        <nav className="wiki-breadcrumbs" aria-label={t("wiki.parent")}>
          <Link to={`/wiki/${page.space_id}`}>{wiki.space?.name}</Link>
          {ancestors.map((p) => (
            <Link key={p.id} to={`/wiki/${p.space_id}/${p.id}`}>
              {p.title || t("wiki.untitled")}
            </Link>
          ))}
          <span className="wiki-breadcrumb-current" aria-current="page">
            {page.title || t("wiki.untitled")}
          </span>
        </nav>
        <div className="wiki-page-action-buttons">
          <div className="wiki-header-presence" ref={setStatusContainer} />
          <Button
            variant="ghost"
            size="icon"
            disabled={page.role === 0}
            aria-label={t(page.favorite ? "wiki.unfavorite" : "wiki.favorite")}
            aria-pressed={!!page.favorite}
            onClick={() => void favorite()}
          >
            <Icon name="star" />
          </Button>
          {page.role >= 4 && wiki.can("sharing.internal") && (
            <Popover.Root
              open={panel === "share"}
              onOpenChange={(open) => setPanel(open ? "share" : null)}
            >
              <Popover.Trigger render={<Button variant="ghost" />}>
                {t("wiki.share")}
              </Popover.Trigger>
              <PopoverPopup
                className="wiki-share-popover"
                positionerProps={{ align: "end", sideOffset: 8 }}
              >
                <Share page={page} onClose={() => setPanel(null)} />
              </PopoverPopup>
            </Popover.Root>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("wiki.comments")}
            aria-pressed={panel === "comments"}
            onClick={() => setPanel(panel === "comments" ? null : "comments")}
          >
            <Icon name="message" />
          </Button>
          <Menu.Root>
            <Menu.Trigger
              render={<Button variant="ghost" size="icon" aria-label={t("wiki.pageActions")} />}
            >
              <Icon name="more" />
            </Menu.Trigger>
            <MenuPopup positionerProps={{ align: "end" }}>
              <Menu.Item
                onClick={() => {
                  void (navigator.clipboard?.writeText(location.href) ?? Promise.reject())
                    .then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    })
                    .catch(() => setError(t("wiki.copyLinkFailed")));
                }}
              >
                <Icon name="link" />
                {t("wiki.copyLink")}
              </Menu.Item>
              {page.role >= 3 && wiki.can("pages.create") && (
                <Menu.Item
                  disabled={wiki.creatingPage}
                  onClick={() =>
                    void wiki
                      .createPage(page.id)
                      .catch((failure) => setError(errorMessage(failure)))
                  }
                >
                  <Icon name="plus" />
                  {t("wiki.newChildPage")}
                </Menu.Item>
              )}
              {page.role >= 3 && wiki.can("history.read") && (
                <Menu.Item onClick={() => setPanel("history")}>
                  <Icon name="clock" />
                  {t("wiki.history")}
                </Menu.Item>
              )}
              {page.role >= 4 && wiki.can("pages.move") && (
                <Menu.Item onClick={() => setPanel("move")}>
                  <Icon name="move" />
                  {t("wiki.move")}
                </Menu.Item>
              )}
              {page.role > 0 && wiki.can("pages.export") && (
                <Menu.Item onClick={() => void exportPage()}>
                  <Icon name="download" />
                  {t("wiki.export")}
                </Menu.Item>
              )}
              {page.role >= 3 && wiki.can("pages.delete") && (
                <>
                  <Menu.Separator />
                  <Menu.Item
                    data-variant="danger"
                    disabled={!!client?.unsaved}
                    onClick={() => void trash()}
                  >
                    <Icon name="trash" />
                    {t("wiki.trashPage")}
                  </Menu.Item>
                </>
              )}
            </MenuPopup>
          </Menu.Root>
        </div>
      </WikiPageHeader>
      {error && (
        <p role="alert" className="wiki-error">
          {error}
        </p>
      )}
      {copied && (
        <p className="wiki-copy-notice" role="status">
          {t("wiki.linkCopied")}
        </p>
      )}
      {revisionState && panel === "history" && (
        <div className="wiki-document-width wiki-version-canvas">
          <div className="wiki-version-label">
            <Icon name="clock" />
            {t("wiki.versionPreview")}
          </div>
          <WikiRevisionPreview state={revisionState} />
        </div>
      )}
      <div className="wiki-document-width" hidden={!!revisionState && panel === "history"}>
        <div className="wiki-page-meta">
          <WikiPageIcon page={page} />
          <span>
            {page.permission_mode === "restricted" && (
              <>
                <Icon name="shield" />
                {t("wiki.restricted")}
              </>
            )}
          </span>
        </div>
        <CollaborativeEditor
          resourceId={page.resource_id}
          transport={transport}
          onTitle={updateTitle}
          onClient={setClient}
          statusContainer={statusContainer}
        />
        {wiki.pages.some((p) => p.parent_id === page.id) && (
          <ul className="wiki-child-pages">
            {wiki.pages
              .filter((p) => p.parent_id === page.id)
              .map((p) => (
                <li key={p.id}>
                  <Link to={`/wiki/${p.space_id}/${p.id}`}>
                    <Icon name="file" />
                    {p.title || t("wiki.untitled")}
                  </Link>
                </li>
              ))}
          </ul>
        )}
        <p className="wiki-page-updated">
          {t("wiki.updatedDate", { date: formatDateTime(page.updated_at) })}
        </p>
        <Discussion key={page.id} page={page} />
      </div>
      {page.role > 0 && panel === "comments" && (
        <WikiSidePanel title={t("wiki.comments")} onClose={() => setPanel(null)}>
          <Discussion key={page.id} page={page} comments />
        </WikiSidePanel>
      )}
      {page.role > 0 && panel === "history" && (
        <History
          page={page}
          client={client}
          onClose={() => setPanel(null)}
          onPreview={setRevisionState}
        />
      )}
      {page.role > 0 && panel === "move" && <Move page={page} onClose={() => setPanel(null)} />}
      {blocker.state === "blocked" && (
        <WikiDialog title={t("wiki.saving")} open onClose={() => blocker.reset()}>
          <p>{t("wiki.unsavedNavigation")}</p>
          <div className="wiki-dialog-actions">
            <Button onClick={() => blocker.reset()}>{t("wiki.cancel")}</Button>
            <Button variant="danger" onClick={() => blocker.proceed()}>
              {t("wiki.leavePage")}
            </Button>
          </div>
        </WikiDialog>
      )}
    </article>
  );
}
export function WikiPage() {
  const wiki = useWiki(),
    [params] = useSearchParams(),
    view = params.get("view"),
    page = wiki.pages.find((p) => p.id === wiki.pageId);
  if (wiki.loading)
    return (
      <p className="wiki-empty" role="status">
        {t("wiki.loading")}
      </p>
    );
  if (page?.role === 0) return <OpenPage key={page.id} page={page} />;
  if (!wiki.space) return <WikiHome />;
  if (params.get("q")?.trim())
    return (
      <PageList
        key={`${wiki.space.id}/search/${params.get("q")}`}
        view="search"
        query={params.get("q")!.trim()}
      />
    );
  if (view === "members") return <Members key={wiki.space.id} />;
  if (view === "trash" || view === "favorites")
    return <PageList key={`${wiki.space.id}/${view}`} view={view} />;
  if (wiki.pageId && !page)
    return (
      <p className="wiki-empty" role="alert">
        {t("wiki.notFound")}
      </p>
    );
  if (!page) return <WikiHome />;
  return <OpenPage key={page.id} page={page} />;
}
