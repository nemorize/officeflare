import { useSession } from "../lib/session";
import { WikiPeople, WikiAvatar } from "../components/wiki-people";
import { PersonPhotosProvider } from "../components/person-avatar";
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
import { LoadingSkeleton } from "../components/loading-skeleton";
import { formatDateTime } from "../lib/regional";
import { WorkspaceConfirm, WorkspaceNotice } from "../components/workspace-dialog";
import { WikiRenameDialog } from "../components/wiki-rename-dialog";
import { useAccount } from "../components/account-context";
import { CollaborativeEditor, downloadText } from "../components/collaborative-editor";
import {
  useNotifications,
  Button,
  Icon,
  Input,
  Menu,
  MenuPopup,
  SelectControl,
  Textarea,
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
type Member = {
  user_id: string;
  email_address: string;
  display_name: string | null;
  role: string;
  has_profile_image?: boolean;
  profile_image_version?: string | null;
};
type Asset = { id: string; filename: string; byte_size: number; content_type: string };
const roleName = (role: string) =>
  role === "owner"
    ? t("wiki.owner")
    : wikiRoles.includes(role as (typeof wikiRoles)[number])
      ? t(`wiki.${role as (typeof wikiRoles)[number]}`)
      : t("wiki.none");

function Members() {
  const notify = useNotifications();
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
      notify.success(t("wiki.saved"));
      wiki.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  if (!version && !error)
    return (
      <section className="wiki-settings">
        <h1>{t("wiki.members")}</h1>
        <LoadingSkeleton kind="list" rows={4} />
      </section>
    );
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
            <WikiAvatar
              id={member.user_id}
              name={member.display_name || member.email_address}
              person={member}
            />
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
  const notify = useNotifications();
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
          .map(
            (page) =>
              `${page.id}:${page.projected_epoch}:${page.projected_seq}:${page.role}:${page.title}`,
          )
          .join("|")
      : "";
  useEffect(() => {
    if (!wiki.space) return;
    const abort = new AbortController();
    request.current = abort;
    setBusy(false);
    setLoading(true);
    setError("");
    const local =
      view === "search"
        ? wiki.pages.filter(
            (page) =>
              page.role > 0 && page.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
          )
        : [];
    if (view === "search") setPages((previous) => (previous.length ? previous : local));
    else setPages([]);
    setCursor(null);
    void api<{ pages: Page[]; next_cursor: string | null }>(
      `/api/wiki/spaces/${wiki.space.id}/pages?${filter}`,
      { signal: abort.signal },
    )
      .then((result) => {
        if (!abort.signal.aborted) {
          setPages(
            view === "search"
              ? [...new Map([...result.pages, ...local].map((page) => [page.id, page])).values()]
              : result.pages,
          );
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
      setPages((previous) => [
        ...new Map([...previous, ...result.pages].map((page) => [page.id, page])).values(),
      ]);
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
      notify.success(t(remove ? "wiki.deleted" : "wiki.restored"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className={`wiki-settings${view === "search" ? " wiki-search-page" : ""}`}
      aria-busy={loading}
    >
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
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void change(page).catch((failure) => notify.error(errorMessage(failure)))
                      }
                    >
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
      {loading && !pages.length ? (
        <LoadingSkeleton kind="list" rows={4} />
      ) : (
        !loading &&
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
        <WorkspaceConfirm
          title={t("wiki.deleteForever")}
          description={t("wiki.confirmDelete")}
          confirm={t("wiki.deleteForever")}
          destructive
          onClose={() => setRemoving(null)}
          action={() => change(removing, true)}
        />
      )}
    </section>
  );
}
function Share({ page, onClose }: { page: Page; onClose: () => void }) {
  const notify = useNotifications();
  const wiki = useWiki(),
    [members, setMembers] = useState<Member[]>([]),
    [grants, setGrants] = useState<Record<string, string>>({}),
    [mode, setMode] = useState("inherit"),
    [version, setVersion] = useState(0),
    [aclVersion, setAclVersion] = useState(0),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [access, setAccess] = useState<Record<string, { role: number; inherited_role: number }>>(
    {},
  );
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const [people, current] = await Promise.all([
        api<{ members: Member[] }>(`/api/wiki/spaces/${page.space_id}/people`, { signal }),
        api<{
          people: { user_id: string; role: number; inherited_role: number }[];
          grants: Member[];
          permission_mode: string;
          version: number;
          acl_version: number;
        }>(`/api/wiki/pages/${page.id}/grants`, { signal }),
      ]);
      if (signal?.aborted) return;
      setMembers(people.members);
      setAccess(Object.fromEntries(current.people.map((p) => [p.user_id, p])));
      setGrants(Object.fromEntries(current.grants.map((g) => [g.user_id, g.role])));
      setMode(current.permission_mode);
      setVersion(current.version);
      setAclVersion(current.acl_version);
    },
    [page.id, page.space_id],
  );
  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal).catch((e) => {
      if (!abort.signal.aborted) setError(errorMessage(e));
    });
    return () => abort.abort();
  }, [load]);
  const rankName = (rank: number) =>
    roleName(["", "viewer", "commenter", "editor", "manager", "owner"][rank] ?? "");
  const save = async () => {
    if (busy) return;
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
      notify.success(t("wiki.saved"));
      onClose();
    } catch (e) {
      if ((e as { status?: number }).status === 412) {
        setVersion(0);
        try {
          await load();
          setError(t("wiki.permissionsReloaded"));
        } catch (failure) {
          setError(errorMessage(failure));
        }
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  if (!version && !error)
    return (
      <WikiDialog
        open
        wide
        busy={busy}
        title={t("wiki.shareTitle", { title: page.title || t("wiki.untitled") })}
        onClose={onClose}
      >
        <LoadingSkeleton kind="list" rows={3} />
      </WikiDialog>
    );
  return (
    <WikiDialog
      open
      wide
      busy={busy}
      title={t("wiki.shareTitle", { title: page.title || t("wiki.untitled") })}
      onClose={onClose}
      className="wiki-share-dialog"
    >
      <ul className="wiki-members">
        {members.map((member) => (
          <li key={member.user_id}>
            <WikiAvatar
              id={member.user_id}
              name={member.display_name || member.email_address}
              person={member}
            />
            <div className="wiki-share-person">
              <span>{member.display_name || member.email_address}</span>
              <small>
                {t("wiki.currentAccess", { role: rankName(access[member.user_id]?.role ?? 0) })}
              </small>
            </div>
            {member.role === "owner" || member.role === "manager" ? (
              <span className="wiki-role-label">{roleName(member.role)}</span>
            ) : (
              <SelectControl
                aria-label={`${member.email_address} ${t("wiki.role")}`}
                value={grants[member.user_id] ?? ""}
                disabled={busy}
                onValueChange={(value) => setGrants((old) => ({ ...old, [member.user_id]: value }))}
                options={[
                  {
                    value: "",
                    label:
                      mode === "inherit"
                        ? t("wiki.inheritedRole", {
                            role: rankName(access[member.user_id]?.inherited_role ?? 0),
                          })
                        : t("wiki.none"),
                  },
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
      <WorkspaceNotice error={error} />
      <div className="wiki-share-footer">
        <Button
          variant="ghost"
          onClick={() =>
            void (navigator.clipboard?.writeText(location.href) ?? Promise.reject())
              .then(() => notify.success(t("wiki.linkCopied")))
              .catch(() => notify.error(t("wiki.copyLinkFailed")))
          }
        >
          <Icon name="link" />
          {t("wiki.copyLink")}
        </Button>
        <div className="wiki-share-actions">
          <Button onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy || !version}>
            {t(busy ? "common.saving" : "wiki.save")}
          </Button>
        </div>
      </div>
    </WikiDialog>
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
  const notify = useNotifications();
  const wiki = useWiki(),
    [revisions, setRevisions] = useState<
      { id: string; epoch: number; seq: number; created_at: number }[]
    >([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [restoring, setRestoring] = useState<string | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [preview, setPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
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
    try {
      const result = await api<{ revisions: typeof revisions }>(
        `/api/collaboration/resources/${page.resource_id}/snapshots`,
      );
      setRevisions(result.revisions);
    } finally {
      setLoading(false);
    }
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
        notify.success(t("wiki.restored"));
        onClose();
      } else {
        await api(`/api/collaboration/resources/${page.resource_id}/snapshots`, { method: "POST" });
        await load();
        notify.success(t("wiki.saved"));
      }
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
          disabled={busy || loading || !!client?.unsaved}
          onClick={() => void change().catch((failure) => setError(errorMessage(failure)))}
        >
          {t("wiki.checkpoint")}
        </Button>
      )}
      {loading && !error && <LoadingSkeleton kind="list" rows={3} />}
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
      {selected && !preview && !error && <LoadingSkeleton kind="reader" rows={2} />}
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
        <WorkspaceConfirm
          title={t("wiki.restore")}
          description={t("wiki.confirmRestore")}
          confirm={t("wiki.restore")}
          onClose={() => setRestoring(null)}
          action={() => change(restoring)}
        />
      )}
    </WikiSidePanel>
  );
}
function Move({ page, onClose }: { page: Page; onClose: () => void }) {
  const notify = useNotifications();
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
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      await api(`/api/wiki/pages/${page.id}/moves`, {
        method: "POST",
        body: { parent_id: parent || null, version: page.version },
      });
      wiki.refresh();
      notify.success(t("wiki.moved"));
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <WikiDialog title={t("wiki.move")} open busy={busy} onClose={onClose}>
      <Input
        autoFocus
        disabled={busy}
        type="search"
        aria-label={t("wiki.parent")}
        placeholder={t("wiki.search")}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="wiki-move-destinations" role="listbox" aria-label={t("wiki.parent")}>
        {wiki.space!.role >= 4 && !query && (
          <button
            disabled={busy}
            role="option"
            aria-selected={!parent}
            onClick={() => setParent("")}
          >
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
              disabled={busy}
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
      <WorkspaceNotice error={error} />
      <div className="wiki-dialog-actions">
        <Button onClick={onClose} disabled={busy}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="primary"
          disabled={busy || parent === (page.parent_id ?? "")}
          onClick={() => void save()}
        >
          {t(busy ? "common.saving" : "wiki.move")}
        </Button>
      </div>
    </WikiDialog>
  );
}
function Discussion({ page, comments = false }: { page: Page; comments?: boolean }) {
  const account = useAccount();
  const sessionId = useSession().session?.tokens.session_id;
  const draftKey = `officeflare.wiki.draft.${sessionId}.${page.id}`;
  const pending = useRef(false),
    request = useRef<AbortController | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const wiki = useWiki(),
    [entries, setComments] = useState<WikiComment[]>([]),
    [assets, setAssets] = useState<Asset[]>([]),
    [draft, setDraft] = useState(() => {
      try {
        return sessionStorage.getItem(draftKey) ?? "";
      } catch {
        return "";
      }
    }),
    [error, setError] = useState(""),
    [loadError, setLoadError] = useState(""),
    [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      if (comments) {
        let cursor: string | null = null;
        const all: WikiComment[] = [];
        do {
          const data: { comments: WikiComment[]; next_cursor: string | null } = await api(
            `/api/wiki/pages/${page.id}/comments${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
            { signal: controller.signal },
          );
          all.unshift(...data.comments);
          cursor = data.next_cursor;
        } while (cursor && !controller.signal.aborted);
        if (!controller.signal.aborted) setComments(all);
      } else {
        const data = await api<{ assets: Asset[] }>(`/api/wiki/pages/${page.id}/assets`, {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setAssets(data.assets);
      }
      if (!controller.signal.aborted) setLoadError("");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [page.id, comments]);
  useEffect(() => {
    const run = () => {
      if (!pending.current)
        void load().catch((e) => {
          if (e?.name !== "AbortError") setLoadError(errorMessage(e));
        });
    };
    run();
    const timer = setInterval(run, 10000);
    return () => {
      clearInterval(timer);
      request.current?.abort();
    };
  }, [load]);
  const post = async () => {
    if (pending.current) return;
    pending.current = true;
    setError("");
    setBusy(true);
    try {
      await api(`/api/wiki/pages/${page.id}/comments`, { method: "POST", body: { body: draft } });
      setDraft("");
      try {
        sessionStorage.removeItem(draftKey);
      } catch {}
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const attach = async (file: File) => {
    if (pending.current) return;
    pending.current = true;
    setError("");
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
      pending.current = false;
      setBusy(false);
    }
  };
  const download = async (asset: Asset) => {
    setError("");
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
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await api(`/api/wiki/pages/${page.id}/comments/${comment.id}`, {
        method: "PATCH",
        body: { resolved: !comment.resolved_at, version: comment.version },
      });
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <div className={`wiki-discussion ${comments ? "is-comments" : ""}`}>
      {loading && <LoadingSkeleton kind="list" rows={3} />}
      {(error || loadError) && (
        <p role="alert" className="wiki-error">
          {error || loadError}
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
                  <WikiAvatar
                    id={comment.author_user_id}
                    name={comment.author_name}
                    person={comment}
                  />
                  <strong>{comment.author_name}</strong>
                  <time dateTime={new Date(comment.created_at * 1000).toISOString()}>
                    {formatDateTime(comment.created_at)}
                  </time>
                </div>
                <p>{comment.body}</p>
                {(page.role >= 4 || comment.author_user_id === account.user?.id) &&
                  wiki.can("comments.create") && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void resolve(comment)}
                    >
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
                onChange={(event) => {
                  setDraft(event.target.value);
                  try {
                    sessionStorage.setItem(draftKey, event.target.value);
                  } catch {}
                }}
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
  const notify = useNotifications();
  const command = useRef(false);
  const [commandBusy, setCommandBusy] = useState(false);
  const wiki = useWiki(),
    navigate = useNavigate(),
    [params, setParams] = useSearchParams(),
    [panel, setPanel] = useState<
      "share" | "history" | "move" | "comments" | "rename" | "trash" | null
    >(params.get("panel") === "comments" ? "comments" : null),
    [client, setClient] = useState<CollaborationClient | null>(null),
    [statusContainer, setStatusContainer] = useState<HTMLDivElement | null>(null),
    [revisionState, setRevisionState] = useState<string | null>(null),
    [, render] = useState(0);
  useEffect(() => {
    if (params.get("panel") === "comments" && page.role > 0) {
      setPanel("comments");
      const next = new URLSearchParams(params);
      next.delete("panel");
      setParams(next, { replace: true });
    }
  }, [params, page.role, setParams]);
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
    if (command.current) return;
    command.current = true;
    setCommandBusy(true);
    try {
      await api(`/api/wiki/pages/${page.id}/trash`, {
        method: "POST",
        body: { version: page.version },
      });
      wiki.refresh();
      notify.success(t("wiki.trashed"));
      navigate(`/wiki/${page.space_id}`);
    } finally {
      command.current = false;
      setCommandBusy(false);
    }
  };
  const favorite = async () => {
    if (command.current) return;
    command.current = true;
    setCommandBusy(true);
    try {
      await api(`/api/wiki/pages/${page.id}/favorite`, {
        method: page.favorite ? "DELETE" : "PUT",
      });
      wiki.refresh();
    } catch (e) {
      notify.error(errorMessage(e));
    } finally {
      command.current = false;
      setCommandBusy(false);
    }
  };
  const exportPage = async () => {
    if (command.current) return;
    command.current = true;
    setCommandBusy(true);
    try {
      const content = await api<Blob>(`/api/wiki/pages/${page.id}/export`, { response: "blob" });
      downloadText(`${page.title || t("wiki.untitled")}.txt`, await content.text());
    } catch (e) {
      notify.error(errorMessage(e));
    } finally {
      command.current = false;
      setCommandBusy(false);
    }
  };
  useEffect(() => {
    if (!client?.synced || !params.has("action")) return;
    const action = params.get("action");
    if (action === "share" && page.role >= 4 && wiki.can("sharing.internal")) setPanel("share");
    if (action === "move" && page.role >= 4 && wiki.can("pages.move")) setPanel("move");
    if (action === "rename" && page.role >= 3 && wiki.can("pages.update")) {
      setPanel("rename");
    }
    if (action === "trash" && client.unsaved) return;
    if (action === "trash" && page.role >= 3 && wiki.can("pages.delete")) {
      setPanel("trash");
    }
    const next = new URLSearchParams(params);
    next.delete("action");
    setParams(next, { replace: true });
  }, [client?.synced, client?.unsaved, params, page.role]);

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
            disabled={page.role === 0 || commandBusy}
            aria-label={t(page.favorite ? "wiki.unfavorite" : "wiki.favorite")}
            aria-pressed={!!page.favorite}
            onClick={() => void favorite()}
          >
            <Icon name="star" />
          </Button>
          {page.role >= 4 && wiki.can("sharing.internal") && (
            <Button variant="ghost" onClick={() => setPanel("share")}>
              {t("wiki.share")}
            </Button>
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
                    .then(() => notify.success(t("wiki.linkCopied")))
                    .catch(() => notify.error(t("wiki.copyLinkFailed")));
                }}
              >
                <Icon name="link" />
                {t("wiki.copyLink")}
              </Menu.Item>
              {page.role >= 3 && wiki.can("pages.update") && (
                <Menu.Item
                  disabled={!client?.capabilities.write}
                  onClick={() => setPanel("rename")}
                >
                  <Icon name="edit" />
                  {t("wiki.rename")}
                </Menu.Item>
              )}
              {page.role >= 3 && wiki.can("pages.create") && (
                <Menu.Item
                  disabled={wiki.creatingPage}
                  onClick={() =>
                    void wiki
                      .createPage(page.id)
                      .catch((failure) => notify.error(errorMessage(failure)))
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
                    disabled={!!client?.unsaved || commandBusy}
                    onClick={() => setPanel("trash")}
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
          renderParticipant={(p) => <WikiAvatar id={p.user_id} name={p.name} />}
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
      {page.role >= 4 && wiki.can("sharing.internal") && panel === "share" && (
        <Share page={page} onClose={() => setPanel(null)} />
      )}
      {page.role >= 3 && wiki.can("pages.update") && client && panel === "rename" && (
        <WikiRenameDialog client={client} onClose={() => setPanel(null)} />
      )}
      {page.role >= 3 && wiki.can("pages.delete") && panel === "trash" && (
        <WorkspaceConfirm
          title={t("wiki.trashPage")}
          description={t("wiki.confirmTrash", { title: page.title || t("wiki.untitled") })}
          confirm={t("wiki.trashPage")}
          destructive
          onClose={() => setPanel(null)}
          action={trash}
        />
      )}

      {blocker.state === "blocked" && (
        <WikiDialog title={t("wiki.unsavedChanges")} open onClose={() => blocker.reset()}>
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
    return wiki.pageId ? (
      <div className="wiki-document-width">
        <LoadingSkeleton kind="reader" rows={3} />
      </div>
    ) : (
      <LoadingSkeleton kind="page" rows={4} />
    );
  if (page?.role === 0)
    return (
      <WikiPeople key={page.id} pageId={page.id}>
        <OpenPage page={page} />
      </WikiPeople>
    );
  if (!wiki.space) return <WikiHome />;
  if (params.get("q")?.trim())
    return (
      <PageList
        key={`${wiki.space.id}/search/${params.get("q")}`}
        view="search"
        query={params.get("q")!.trim()}
      />
    );
  if (view === "members")
    return (
      <PersonPhotosProvider
        key={wiki.space.id}
        basePath={`/api/wiki/spaces/${wiki.space.id}/people`}
      >
        <Members />
      </PersonPhotosProvider>
    );
  if (view === "trash" || view === "favorites")
    return <PageList key={`${wiki.space.id}/${view}`} view={view} />;
  if (wiki.pageId && !page)
    return (
      <p className="wiki-empty" role="alert">
        {t("wiki.notFound")}
      </p>
    );
  if (!page) return <WikiHome />;
  return (
    <WikiPeople key={page.id} pageId={page.id}>
      <OpenPage page={page} />
    </WikiPeople>
  );
}
