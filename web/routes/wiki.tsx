import { useCallback, useEffect, useState } from "react";
import { Link, useBlocker, useNavigate, useSearchParams } from "react-router";
import { t } from "../../shared/i18n/index.ts";
import { wikiRoles, type WikiComment, type WikiPage as Page } from "../../shared/wiki";
import { api, errorMessage } from "../lib/api";
import type { CollaborationClient, CollaborationTransport } from "../lib/collaboration/client";
import { useWiki } from "../components/wiki-context";
import { WikiDialog } from "../components/wiki-chrome";
import { CollaborativeEditor, downloadText } from "../components/collaborative-editor";
import { Button, Icon, Input } from "../components/ui";
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
  const change = async (member?: Member) => {
    if (!wiki.space) return;
    setBusy(true);
    setError("");
    try {
      if (member)
        await api(
          `/api/wiki/spaces/${wiki.space.id}/members/${member.user_id}?version=${version}`,
          { method: "DELETE" },
        );
      else
        await api(`/api/wiki/spaces/${wiki.space.id}/members`, {
          method: "PUT",
          body: { email, role, version },
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
      <p>{wiki.space?.name}</p>
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
          <select
            aria-label={t("wiki.role")}
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            {wikiRoles.map((r) => (
              <option key={r} value={r}>
                {roleName(r)}
              </option>
            ))}
          </select>
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
            <span>{roleName(member.role)}</span>
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
function PageList({ view }: { view: string }) {
  const wiki = useWiki(),
    [pages, setPages] = useState<Page[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!wiki.space) return;
    const abort = new AbortController();
    void api<{ pages: Page[] }>(
      `/api/wiki/spaces/${wiki.space.id}/pages?${view === "trash" ? "trash=true" : "favorites=true"}`,
      { signal: abort.signal },
    )
      .then((v) => {
        if (!abort.signal.aborted) setPages(v.pages);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(errorMessage(e));
      });
    return () => abort.abort();
  }, [wiki.space?.id, view, revision]);
  const change = async (page: Page, remove = false) => {
    if (remove && !window.confirm(t("wiki.confirmDelete"))) return;
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
      <h1>{t(view === "trash" ? "wiki.trash" : "wiki.favorites")}</h1>
      {view === "trash" && <p>{t("wiki.trashHint")}</p>}
      {error && (
        <p role="alert" className="wiki-error">
          {error}
        </p>
      )}
      <ul className="wiki-members">
        {pages.map((page) => (
          <li key={page.id}>
            {view === "trash" ? (
              <strong>{page.title || t("wiki.untitled")}</strong>
            ) : (
              <Link to={`/wiki/${page.space_id}/${page.id}`}>
                {page.title || t("wiki.untitled")}
              </Link>
            )}
            {view === "trash" && wiki.can("pages.delete") && (
              <>
                <Button disabled={busy} onClick={() => void change(page)}>
                  {t("wiki.restore")}
                </Button>
                {wiki.space!.role >= 4 && (
                  <Button variant="danger" disabled={busy} onClick={() => void change(page, true)}>
                    {t("wiki.deleteForever")}
                  </Button>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
      {!pages.length && <p className="wiki-muted">{t("wiki.noResults")}</p>}
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
    <WikiDialog title={t("wiki.share")} open onClose={onClose}>
      <select aria-label={t("wiki.share")} value={mode} onChange={(e) => setMode(e.target.value)}>
        <option value="inherit">{t("wiki.inherit")}</option>
        <option value="restricted">{t("wiki.restricted")}</option>
      </select>
      <p className="wiki-muted">{t("wiki.restrictionHint")}</p>
      <ul className="wiki-members">
        {members
          .filter((m) => m.role !== "owner" && m.role !== "manager")
          .map((member) => (
            <li key={member.user_id}>
              <span>{member.display_name || member.email_address}</span>
              <select
                aria-label={`${member.email_address} ${t("wiki.role")}`}
                value={grants[member.user_id] ?? ""}
                onChange={(e) => setGrants((old) => ({ ...old, [member.user_id]: e.target.value }))}
              >
                <option value="">{t("wiki.none")}</option>
                {wikiRoles.map((r) => (
                  <option key={r} value={r}>
                    {roleName(r)}
                  </option>
                ))}
              </select>
            </li>
          ))}
      </ul>
      {error && <p role="alert">{error}</p>}
      <div className="wiki-dialog-actions">
        <Button variant="primary" onClick={() => void save()} disabled={busy || !version}>
          {t("wiki.save")}
        </Button>
      </div>
    </WikiDialog>
  );
}
function History({
  page,
  client,
  onClose,
}: {
  page: Page;
  client: CollaborationClient | null;
  onClose: () => void;
}) {
  const wiki = useWiki(),
    [revisions, setRevisions] = useState<
      { id: string; epoch: number; seq: number; created_at: number }[]
    >([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
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
    if (snapshot && !window.confirm(t("wiki.confirmRestore"))) return;
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
    <WikiDialog title={t("wiki.history")} open onClose={onClose}>
      {error && <p role="alert">{error}</p>}
      {wiki.can("pages.update") && (
        <Button disabled={busy || !!client?.unsaved} onClick={() => void change()}>
          {t("wiki.checkpoint")}
        </Button>
      )}
      <ul className="wiki-members">
        {revisions.map((revision) => (
          <li key={revision.id}>
            <time dateTime={new Date(revision.created_at).toISOString()}>
              {new Date(revision.created_at).toLocaleString()}
            </time>
            {wiki.can("history.restore") && (
              <Button
                disabled={busy || !client?.epoch || !!client?.unsaved}
                onClick={() => void change(revision.id)}
              >
                {t("wiki.restore")}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </WikiDialog>
  );
}
function Move({ page, onClose }: { page: Page; onClose: () => void }) {
  const wiki = useWiki(),
    [parent, setParent] = useState(page.parent_id ?? ""),
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
      <select
        aria-label={t("wiki.parent")}
        value={parent}
        onChange={(e) => setParent(e.target.value)}
      >
        {wiki.space!.role >= 4 && <option value="">{t("wiki.root")}</option>}
        {wiki.pages
          .filter((p) => !descendants.has(p.id) && p.role >= 4)
          .map((p) => (
            <option key={p.id} value={p.id}>
              {p.title || t("wiki.untitled")}
            </option>
          ))}
      </select>
      {error && <p role="alert">{error}</p>}
      <div className="wiki-dialog-actions">
        <Button disabled={busy} onClick={() => void save()}>
          {t("wiki.move")}
        </Button>
      </div>
    </WikiDialog>
  );
}
function Discussion({ page }: { page: Page }) {
  const wiki = useWiki(),
    [comments, setComments] = useState<WikiComment[]>([]),
    [assets, setAssets] = useState<Asset[]>([]),
    [draft, setDraft] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const [threads, files] = await Promise.all([
      api<{ comments: WikiComment[] }>(`/api/wiki/pages/${page.id}/comments`),
      api<{ assets: Asset[] }>(`/api/wiki/pages/${page.id}/assets`),
    ]);
    setComments(threads.comments);
    setAssets(files.assets);
  }, [page.id]);
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
    <div className="wiki-discussion">
      {error && (
        <p role="alert" className="wiki-error">
          {error}
        </p>
      )}
      <div className="wiki-section-heading">
        <h2>{t("wiki.attachments")}</h2>
        {page.role >= 3 && wiki.can("assets.upload") && (
          <label className="wiki-upload-label">
            <Icon name="attachment" />
            {t("wiki.attach")}
            <input
              type="file"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void attach(file);
                event.target.value = "";
              }}
            />
          </label>
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
      <h2>{t("wiki.comments")}</h2>
      <ul className="wiki-comments">
        {comments.map((comment) => (
          <li key={comment.id} className={comment.resolved_at ? "is-resolved" : ""}>
            <div>
              <strong>{comment.author_name}</strong>
              <time>{new Date(comment.created_at * 1000).toLocaleString()}</time>
            </div>
            <p>{comment.body}</p>
            {page.role >= 4 && wiki.can("comments.create") && (
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
          <textarea
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
    </div>
  );
}
function OpenPage({ page }: { page: Page }) {
  const wiki = useWiki(),
    navigate = useNavigate(),
    [panel, setPanel] = useState<"share" | "history" | "move" | null>(null),
    [error, setError] = useState(""),
    [client, setClient] = useState<CollaborationClient | null>(null),
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
  const ancestors: Page[] = [];
  let parent = page.parent_id;
  while (parent && ancestors.length < 32) {
    const entry = wiki.pages.find((p) => p.id === parent);
    if (!entry) break;
    ancestors.unshift(entry);
    parent = entry.parent_id;
  }
  return (
    <article className="wiki-page">
      <div className="wiki-page-actions">
        <nav className="wiki-breadcrumbs" aria-label={t("wiki.parent")}>
          <Link to={`/wiki/${page.space_id}`}>{wiki.space?.name}</Link>
          {ancestors.map((p) => (
            <Link key={p.id} to={`/wiki/${p.space_id}/${p.id}`}>
              {p.title || t("wiki.untitled")}
            </Link>
          ))}
        </nav>
        {wiki.can("pages.export") && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("wiki.export")}
            onClick={() => void exportPage()}
          >
            <Icon name="download" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          aria-label={t(page.favorite ? "wiki.unfavorite" : "wiki.favorite")}
          onClick={() => void favorite()}
        >
          <Icon name="star" />
        </Button>
        {page.role >= 3 && wiki.can("history.read") && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("wiki.history")}
            onClick={() => setPanel("history")}
          >
            <Icon name="clock" />
          </Button>
        )}
        {page.role >= 4 && wiki.can("pages.move") && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("wiki.move")}
            onClick={() => setPanel("move")}
          >
            <Icon name="move" />
          </Button>
        )}
        {page.role >= 4 && wiki.can("sharing.internal") && (
          <Button onClick={() => setPanel("share")}>
            <Icon name="users" />
            {t("wiki.share")}
          </Button>
        )}
        {page.role >= 3 && wiki.can("pages.delete") && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("wiki.trashPage")}
            disabled={!!client?.unsaved}
            onClick={() => void trash()}
          >
            <Icon name="trash" />
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="wiki-error">
          {error}
        </p>
      )}
      <div className="wiki-document-width">
        <CollaborativeEditor
          resourceId={page.resource_id}
          transport={transport}
          onTitle={updateTitle}
          onClient={setClient}
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
        <Discussion key={page.id} page={page} />
      </div>
      {page.role > 0 && panel === "share" && <Share page={page} onClose={() => setPanel(null)} />}{" "}
      {page.role > 0 && panel === "history" && (
        <History page={page} client={client} onClose={() => setPanel(null)} />
      )}{" "}
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
  if (!wiki.space)
    return (
      <div className="wiki-empty">
        <Icon name="file" />
        <h1>{t("wiki.title")}</h1>
        <p>{t("wiki.empty")}</p>
      </div>
    );
  if (view === "members") return <Members />;
  if (view === "trash" || view === "favorites") return <PageList view={view} />;
  if (wiki.pageId && !page)
    return (
      <p className="wiki-empty" role="alert">
        {t("wiki.notFound")}
      </p>
    );
  if (!page)
    return (
      <div className="wiki-empty">
        <h1>{wiki.space.name}</h1>
        <p>{wiki.space.description || t("wiki.choosePage")}</p>
        {wiki.space.role >= 3 && wiki.can("pages.create") && (
          <Button variant="primary" onClick={() => void wiki.createPage()}>
            <Icon name="plus" />
            {t("wiki.newPage")}
          </Button>
        )}
      </div>
    );
  return <OpenPage key={page.id} page={page} />;
}
