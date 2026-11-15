import { WorkspaceDialog } from "./workspace-dialog";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import { t } from "../../shared/i18n/index.ts";
import type { WikiPage, WikiSpace } from "../../shared/wiki";
import { api, errorMessage } from "../lib/api";
import { useWiki } from "./wiki-context";
import { useNotifications, Button, Icon, Input, Popover, PopoverPopup, Textarea } from "./ui";

export function WikiDialog({
  title,
  open,
  onClose,
  children,
  busy = false,
  wide = false,
  className = "",
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  busy?: boolean;
  wide?: boolean;
  className?: string;
}) {
  return open ? (
    <WorkspaceDialog
      title={title}
      onClose={onClose}
      busy={busy}
      wide={wide}
      className={`wiki-dialog ${className}`}
      closeLabel={t("wiki.close")}
    >
      <div className="wiki-dialog-body">{children}</div>
    </WorkspaceDialog>
  ) : null;
}

export function WikiSpaceDialog({ space, onClose }: { space?: WikiSpace; onClose: () => void }) {
  const notify = useNotifications();
  const wiki = useWiki(),
    navigate = useNavigate();
  const [name, setName] = useState(space?.name ?? ""),
    [description, setDescription] = useState(space?.description ?? ""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ space: WikiSpace }>(
        `/api/wiki/spaces${space ? `/${space.id}` : ""}`,
        {
          method: space ? "PATCH" : "POST",
          body: {
            name,
            description: space ? description : description.trim() || undefined,
            ...(space ? { version: space.version } : {}),
          },
        },
      );
      wiki.refresh();
      notify.success(t("wiki.saved"));
      onClose();
      if (!space) navigate(`/wiki/${result.space.id}`);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <WikiDialog
      title={t(space ? "wiki.spaceSettings" : "wiki.newSpace")}
      busy={busy}
      open
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="wiki-space-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label>
          {t("wiki.spaceName")}
          <Input
            autoFocus
            required
            maxLength={100}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          {t("wiki.description")}
          <Textarea
            maxLength={1000}
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="wiki-error">
            {error}
          </p>
        )}
        <div className="wiki-dialog-actions">
          <Button disabled={busy} onClick={onClose}>
            {t("wiki.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
            {t(space ? "wiki.save" : "wiki.create")}
          </Button>
        </div>
      </form>
    </WikiDialog>
  );
}

const icons = [
  "📄",
  "📚",
  "📌",
  "💡",
  "📝",
  "🗂️",
  "🚀",
  "🎯",
  "🛠️",
  "🧭",
  "🔬",
  "🎨",
  "📊",
  "✅",
  "🌱",
  "💬",
];
export function WikiPageIcon({ page }: { page: WikiPage }) {
  const wiki = useWiki(),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const save = async (icon: string) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ page: WikiPage }>(`/api/wiki/pages/${page.id}`, {
        method: "PATCH",
        body: { icon, version: page.version },
      });
      wiki.updatePage(result.page);
      setOpen(false);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  if (page.role < 3 || !wiki.can("pages.update"))
    return page.icon ? (
      <div className="wiki-page-icon" aria-hidden="true">
        {page.icon}
      </div>
    ) : null;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <Button
            className={`wiki-page-icon ${page.icon ? "" : "is-empty"}`}
            variant="ghost"
            aria-label={t("wiki.changeIcon")}
          />
        }
      >
        {page.icon || (
          <>
            <Icon name="file" />
            <span>{t("wiki.addIcon")}</span>
          </>
        )}
      </Popover.Trigger>
      <PopoverPopup
        className="wiki-icon-picker"
        positionerProps={{ sideOffset: 8, align: "start" }}
      >
        <Popover.Title>{t("wiki.changeIcon")}</Popover.Title>
        <div className="wiki-icon-grid">
          {icons.map((icon) => (
            <Button
              key={icon}
              variant="ghost"
              aria-label={icon}
              disabled={busy}
              onClick={() => void save(icon)}
            >
              {icon}
            </Button>
          ))}
        </div>
        {page.icon && (
          <Button variant="ghost" disabled={busy} onClick={() => void save("")}>
            {t("wiki.removeIcon")}
          </Button>
        )}
        {error && (
          <p className="wiki-error" role="alert">
            {error}
          </p>
        )}
      </PopoverPopup>
    </Popover.Root>
  );
}

export function WikiPageHeader({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setTarget(document.getElementById("wiki-topbar-content")), []);
  const header = <div className="wiki-page-actions">{children}</div>;
  return target ? createPortal(header, target) : header;
}

export function WikiSidePanel({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLElement>(null),
    close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !document.querySelector('[role="alertdialog"]')
      ) {
        event.preventDefault();
        close.current();
      }
    };
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("keydown", escape);
      if (previous?.isConnected) previous.focus();
      else
        document
          .querySelector<HTMLElement>('.wiki-page-action-buttons [data-ui="menu-trigger"]')
          ?.focus();
    };
  }, []);
  return (
    <aside ref={panel} tabIndex={-1} className="wiki-side-panel" aria-label={title}>
      <header>
        <h2>{title}</h2>
        <Button variant="ghost" size="icon" aria-label={t("wiki.close")} onClick={onClose}>
          <Icon name="close" />
        </Button>
      </header>
      <div className="wiki-side-panel-body">{children}</div>
    </aside>
  );
}
