import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { t } from "../../shared/i18n/index.ts";
import type { WikiPage, WikiSpace } from "../../shared/wiki";
import { api, errorMessage } from "../lib/api";
import { useWiki } from "./wiki-context";
import {
  Button,
  Dialog,
  DialogPopup,
  Icon,
  Input,
  Popover,
  PopoverPopup,
  Radio,
  RadioGroup,
  Textarea,
} from "./ui";

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
        <Dialog.Description className="visually-hidden">{title}</Dialog.Description>
        <div className="wiki-dialog-body">{children}</div>
      </DialogPopup>
    </Dialog.Root>
  );
}

export function WikiSpaceDialog({ space, onClose }: { space?: WikiSpace; onClose: () => void }) {
  const wiki = useWiki(),
    navigate = useNavigate();
  const [name, setName] = useState(space?.name ?? ""),
    [description, setDescription] = useState(space?.description ?? ""),
    [kind, setKind] = useState<"team" | "personal">(space?.kind ?? "team"),
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
            ...(space ? { version: space.version } : { kind }),
          },
        },
      );
      wiki.refresh();
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
        {!space && <p className="wiki-muted">{t("wiki.spaceIntro")}</p>}
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
            placeholder={t("wiki.spaceDescriptionPlaceholder")}
          />
        </label>
        {!space && (
          <div className="wiki-space-kinds">
            <span>{t("wiki.spaceType")}</span>
            <RadioGroup
              value={kind}
              onValueChange={(value) => setKind(value as "team" | "personal")}
              aria-label={t("wiki.spaceType")}
            >
              {(["team", "personal"] as const).map((value) => (
                <label key={value}>
                  <Radio.Root
                    value={value}
                    disabled={
                      value === "personal" && wiki.spaces.some((item) => item.kind === "personal")
                    }
                  >
                    <Radio.Indicator />
                  </Radio.Root>
                  <span>
                    <strong>{t(value === "team" ? "wiki.teamSpace" : "wiki.personalSpace")}</strong>
                    <small>
                      {t(value === "team" ? "wiki.teamSpaceHint" : "wiki.personalSpaceHint")}
                    </small>
                  </span>
                </label>
              ))}
            </RadioGroup>
          </div>
        )}
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
