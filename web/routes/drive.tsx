import { LocalizedMessage } from "../components/i18n";
import { t, plural } from "../../shared/i18n/index.ts";
import { Fragment, useEffect, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import {
  Button,
  ContextMenu,
  ContextMenuPopup,
  Icon,
  Menu,
  MenuPopup,
  Toggle,
  ToggleGroup,
  useNotifications,
} from "../components/ui";
import { useDrive, DriveNewMenu } from "../components/drive-context";
import { DriveOwner, DriveOwnerPhotosProvider } from "../components/drive-owner";
import {
  DriveField,
  DriveCheckbox,
  DriveFileIcon,
  DriveIconButton,
  DriveNotice,
  DriveSelect,
  DriveState,
  driveFailure,
  useDriveAction,
  useDriveCollection,
  useDriveResource,
} from "../components/drive-controls";
import {
  DriveConfirmDialog,
  DriveDestinationDialog,
  DriveRenameDialog,
  DriveShareDialog,
  freshItem,
} from "../components/drive-dialogs";
import { DriveDetails } from "../components/drive-details";
import { DrivePreview, downloadDriveItem } from "../components/drive-preview";
import { api } from "../lib/api";
import { useWorkspaceMobile } from "../lib/workspace-responsive";
import {
  driveSearchScopes,
  driveSearchTypes,
  isDriveSearch,
  readDriveSearch,
} from "../lib/drive-search";
import {
  canEdit,
  driveDate,
  driveLocation,
  driveSize,
  fileKind,
  formatBytes,
  selectDriveItems,
  type DriveItem,
} from "../lib/drive";
import "./drive.css";
import { readDriveLayout, saveDriveLayout } from "../lib/drive-settings";

type ItemAction =
  | "open"
  | "share"
  | "rename"
  | "move"
  | "copy"
  | "star"
  | "download"
  | "trash"
  | "restore"
  | "delete"
  | "details";
export function DrivePage({ linkedItem }: { linkedItem?: DriveItem } = {}) {
  const location = useLocation(),
    navigate = useNavigate(),
    [params, setParams] = useSearchParams(),
    drive = useDrive(),
    mobile = useWorkspaceMobile(),
    notify = useNotifications(),
    action = useDriveAction();
  const route = driveLocation(location.pathname),
    folder = linkedItem?.parent_id ?? route.folder,
    searching = isDriveSearch(params),
    searchFields = readDriveSearch(params),
    view = searching ? searchFields.scope : folder ? "all" : route.view,
    query = params.get("q") ?? "",
    kind = params.get("kind") ?? "",
    sort = params.get("sort") ?? (view === "recent" ? "updated_at" : "name"),
    order = params.get("order") ?? (view === "recent" ? "desc" : "asc");
  const [layout, setLayout] = useState(readDriveLayout);
  const folderResource = useDriveResource<{ item: DriveItem }>(
    folder ? `/api/drive/items/${folder}` : null,
    drive.revision,
  );
  const listQuery = new URLSearchParams({
    view,
    limit: "50",
    ...(view === "recent" && !params.has("sort") ? {} : { sort, order }),
    ...(folder ? { parent_id: folder } : searching ? { parent_id: "all" } : {}),
    ...(query ? { q: query } : {}),
    ...(kind ? { kind } : {}),
    ...Object.fromEntries(
      ["content_type", "owner", "after", "before"].flatMap((key) =>
        params.get(key) ? [[key, params.get(key)!]] : [],
      ),
    ),
  });
  const collection = useDriveCollection<DriveItem>(
    `/api/drive/items?${listQuery}`,
    "items",
    drive.revision,
  );
  const [selection, setSelection] = useState(new Set<string>()),
    [selectionMode, setSelectionMode] = useState(false),
    selectionButton = useRef<HTMLButtonElement>(null),
    anchor = useRef<string | null>(null),
    [detailsOpen, setDetailsOpen] = useState(false),
    [preview, setPreview] = useState<DriveItem | null>(null);
  const selected = collection.items.filter((item) => selection.has(item.id)),
    selectedId = selection.size === 1 ? [...selection][0]! : null,
    selecting = mobile && (selectionMode || selection.size > 0),
    showCheckboxes = !mobile || selecting;
  const exitSelection = () => {
    setSelectionMode(false);
    setSelection(new Set());
    anchor.current = null;
    setDetailsOpen(false);
    if (mobile) selectionButton.current?.focus();
  };
  const selectedResource = useDriveResource<{ item: DriveItem }>(
    detailsOpen && selectedId
      ? `/api/drive/items/${selectedId}${view === "trash" ? "?include_trashed=true" : ""}`
      : null,
    drive.revision,
  );
  const detailItem = selectedResource.data?.item ?? selected[0];
  useEffect(() => {
    if (linkedItem?.kind === "file") setPreview(linkedItem);
  }, [linkedItem?.id]);
  const [dialog, setDialog] = useState<{
    type: "share" | "rename" | "move" | "copy" | "trash" | "delete";
    items: DriveItem[];
  } | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<DriveItem[]>([]),
    [dragging, setDragging] = useState(false),
    dragDepth = useRef(0);
  const writable =
    drive.can("create") &&
    (folder
      ? !!folderResource.data &&
        (folderResource.data.item.actions?.create ?? canEdit(folderResource.data.item))
      : view === "my" && !searching);
  const title = searching
    ? t("routesDrive.searchResults")
    : (folderResource.data?.item.name ??
      ({
        my: t("routesDrive.myDrive"),
        shared: t("routesDrive.sharedWithMe"),
        recent: t("routesDrive.recent"),
        starred: t("routesDrive.starred"),
        trash: t("routesDrive.trash"),
      }[view] ||
        t("routesDrive.folder")));
  useEffect(() => {
    drive.setTarget({ parent: folder, writable });
  }, [folder, writable, drive.setTarget]);
  useEffect(() => {
    document.title = t("routesDrive.driveOfficeflare", { title: title });
  }, [title]);
  useEffect(() => {
    if (!mobile) setSelectionMode(false);
  }, [mobile]);
  useEffect(() => {
    setSelection(new Set());
    setSelectionMode(false);
    anchor.current = null;
    setDetailsOpen(false);
    setDialog(null);
    setDragging(false);
    dragDepth.current = 0;
  }, [location.pathname, listQuery.toString()]);
  useEffect(() => {
    if (!collection.loading)
      setSelection(
        (old) => new Set([...old].filter((id) => collection.items.some((item) => item.id === id))),
      );
  }, [collection.items, collection.loading]);
  useEffect(() => {
    const controller = new AbortController();
    setBreadcrumbs([]);
    const currentFolder = folderResource.data?.item;
    if (currentFolder)
      void (async () => {
        const trail: DriveItem[] = [currentFolder],
          visited = new Set([currentFolder.id]);
        let parent = currentFolder.parent_id;
        while (parent && trail.length < 100 && !visited.has(parent)) {
          try {
            const { item } = await api<{ item: DriveItem }>(`/api/drive/items/${parent}`, {
              signal: controller.signal,
            });
            visited.add(item.id);
            trail.unshift(item);
            parent = item.parent_id;
          } catch {
            break;
          }
        }
        if (!controller.signal.aborted) setBreadcrumbs(trail);
      })();
    return () => controller.abort();
  }, [folderResource.data]);
  const changeFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (key === "kind") next.delete("content_type");
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  };
  const chooseLayout = (value: string[]) => {
    const next = value[0];
    if (next === "list" || next === "grid") {
      setLayout(next);
      try {
        saveDriveLayout(next);
      } catch {
        /* Preference is optional. */
      }
    }
  };
  const select = (item: DriveItem, event?: MouseEvent) => {
    setSelection((old) =>
      selectDriveItems(
        collection.items.map((entry) => entry.id),
        old,
        item.id,
        anchor.current,
        !!event?.shiftKey,
        !!(event?.metaKey || event?.ctrlKey),
      ),
    );
    if (!event?.shiftKey) anchor.current = item.id;
  };
  const toggleSelected = (item: DriveItem) => {
    if (mobile) setSelectionMode(true);
    setSelection((old) => {
      const next = new Set(old);
      next.has(item.id) ? next.delete(item.id) : next.add(item.id);
      return next;
    });
    anchor.current = item.id;
  };
  const open = (item: DriveItem) => {
    if (view === "trash") {
      setSelection(new Set([item.id]));
      setDetailsOpen(true);
    } else if (item.kind === "folder") navigate(`/drive/folders/${item.id}`);
    else {
      setPreview(item);
      void freshItem(item.id)
        .then((current) => setPreview((old) => (old?.id === current.id ? current : old)))
        .catch((failure) => notify.error(driveFailure(failure)));
    }
  };
  const operate = (name: ItemAction, items: DriveItem[]) => {
    const first = items[0];
    if (!first) return;
    if (name === "open") return open(first);
    if (name === "details") {
      setSelection(new Set([first.id]));
      setDetailsOpen(true);
      return;
    }
    if (["share", "rename", "move", "copy", "trash", "delete"].includes(name)) {
      setDialog({ type: name as NonNullable<typeof dialog>["type"], items });
      return;
    }
    void action.run(async () => {
      let done = 0;
      const failures: string[] = [];
      for (const item of items)
        try {
          if (name === "download" && item.kind === "file") await downloadDriveItem(item);
          else if (name === "star")
            await api(`/api/drive/items/${item.id}/star`, {
              method: "PUT",
              body: { starred: !item.starred },
            });
          else if (name === "restore") {
            const current = await freshItem(item.id, true);
            await api(`/api/drive/items/${item.id}`, {
              method: "PATCH",
              body: { version: current.version, trashed: false },
            });
          }
          done++;
        } catch (failure) {
          failures.push(`${item.name}: ${driveFailure(failure)}`);
        }
      if (name !== "download") {
        drive.refresh();
        if (done)
          notify.success(
            name === "star" ? t("routesDrive.starredItemsUpdated") : plural("drive.restored", done),
          );
      }
      if (failures.length) throw new Error(failures.join("\n"));
    });
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLElement &&
        event.target.closest(
          'input,textarea,[contenteditable],[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]',
        )
      )
        return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setSelection(new Set(collection.items.map((item) => item.id)));
      }
      if (event.key === "Escape") {
        exitSelection();
      }
      if (
        event.key === "Delete" &&
        selected.length &&
        selected.every((item) => item.effective_role === "owner" && item.actions?.delete !== false)
      ) {
        event.preventDefault();
        operate(view === "trash" ? "delete" : "trash", selected);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    dragDepth.current = 0;
    if (writable) drive.enqueue(Array.from(event.dataTransfer.files), folder);
    else notify.info(t("routesDrive.openAFolderYouCanEditToUploadFiles"));
  };
  const onDrag = (event: DragEvent) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    if (event.type === "dragenter") {
      dragDepth.current++;
      setDragging(true);
    } else if (event.type === "dragleave") {
      dragDepth.current--;
      if (!dragDepth.current) setDragging(false);
    }
  };
  const trashOperation = async () => {
    if (!dialog) return;
    const failures: string[] = [];
    let done = 0;
    for (const item of dialog.items)
      try {
        const current = await freshItem(item.id, dialog.type === "delete");
        await api(
          `/api/drive/items/${item.id}${dialog.type === "delete" ? `?version=${current.version}` : ""}`,
          {
            method: dialog.type === "delete" ? "DELETE" : "PATCH",
            ...(dialog.type === "delete"
              ? {}
              : { body: { version: current.version, trashed: true } }),
          },
        );
        done++;
      } catch (failure) {
        failures.push(`${item.name}: ${driveFailure(failure)}`);
      }
    drive.refresh();
    if (done)
      notify.success(plural(dialog.type === "delete" ? "drive.deleted" : "drive.trashed", done));
    if (failures.length) throw new Error(failures.join("\n"));
    setSelection(new Set());
  };
  const empty = !collection.loading && !collection.error && !collection.items.length;
  return (
    <section
      className={`drive-page${selecting ? " drive-selection-mode" : ""}`}
      onDragEnter={onDrag}
      onDragLeave={onDrag}
      onDragOver={(event) => {
        if (Array.from(event.dataTransfer.types).includes("Files")) event.preventDefault();
      }}
      onDrop={drop}
      aria-label={title}
    >
      <div className="drive-content-pane">
        <header className="drive-page-header">
          <div>
            {folder && (
              <nav aria-label={t("routesDrive.folderPath")} className="drive-breadcrumbs">
                <Link
                  to={
                    folderResource.data?.item.effective_role === "owner"
                      ? "/drive"
                      : "/drive/shared"
                  }
                >
                  {folderResource.data?.item.effective_role === "owner"
                    ? t("routesDrive.myDrive")
                    : t("routesDrive.sharedWithMe")}
                </Link>
                {breadcrumbs.slice(0, -1).map((item) => (
                  <span key={item.id}>
                    <Icon name="chevron" width="12" height="12" />
                    <Link to={`/drive/folders/${item.id}`}>{item.name}</Link>
                  </span>
                ))}
              </nav>
            )}
            <h1>
              <span className="drive-page-title">{title}</span>
              {folder && <Icon name="folder" width="20" height="20" />}
            </h1>
            {searching && (
              <p>
                {[
                  query && `“${query}”`,
                  (params.get("content_type") || kind) &&
                    (driveSearchTypes.find((option) => option.value === searchFields.type)?.label ??
                      searchFields.type),
                  searchFields.scope !== "all" &&
                    driveSearchScopes.find((option) => option.value === searchFields.scope)?.label,
                  searchFields.owner && t("routesDrive.owner", { owner: searchFields.owner }),
                  searchFields.after && t("routesDrive.from", { after: searchFields.after }),
                  searchFields.before && t("routesDrive.through", { before: searchFields.before }),
                ]
                  .filter(Boolean)
                  .join(" · ") || t("routesDrive.allAccessibleFiles")}
              </p>
            )}
          </div>
          <div className="drive-header-actions">
            <div className="drive-inline-new">
              <DriveNewMenu />
            </div>
            {folder && folderResource.data?.item.effective_role === "owner" && (
              <Button
                mobileIcon
                className="drive-folder-share"
                aria-label={t("routesDrive.shareFolder")}
                onClick={() => operate("share", [folderResource.data!.item])}
              >
                <Icon name="users" />
                <span className="drive-share-folder-label">{t("routesDrive.shareFolder")}</span>
              </Button>
            )}
            <DriveIconButton
              icon="refresh"
              label={t("routesDrive.refreshFiles")}
              onClick={drive.refresh}
              disabled={collection.loading}
            />
            {mobile ? (
              <Button
                ref={selectionButton}
                variant="ghost"
                size="touch"
                aria-label={
                  selecting ? t("routesDrive.exitSelectionMode") : t("routesDrive.selectFiles")
                }
                aria-pressed={selecting}
                disabled={!collection.items.length && !selecting}
                onClick={() => {
                  if (selecting) exitSelection();
                  else setSelectionMode(true);
                }}
              >
                {selecting ? t("common.done") : t("routesDrive.select")}
              </Button>
            ) : (
              <DriveIconButton
                icon="sidebar"
                label={
                  detailsOpen
                    ? t("routesDrive.hideFileInformation")
                    : t("routesDrive.showFileInformation")
                }
                aria-pressed={detailsOpen}
                disabled={!selectedId}
                onClick={() => setDetailsOpen(!detailsOpen)}
              />
            )}
          </div>
        </header>
        {view === "trash" && (
          <div className="drive-trash-notice">
            <Icon name="trash" />
            <span>
              <LocalizedMessage
                id="routesDrive.itemsInTrashAreAutomaticallyDeletedAfterDays"
                values={{
                  value1:
                    drive.capabilities?.trash_retention_days ??
                    t("routesDrive.theConfiguredNumberOf"),
                }}
              />
            </span>
          </div>
        )}
        <div className="drive-toolbar-slot">
          <div
            className={`drive-view-toolbar${selection.size ? " is-hidden" : ""}`}
            aria-hidden={selection.size > 0}
          >
            <div className="drive-filters">
              <DriveSelect
                label={t("routesDrive.filterByType")}
                value={kind || "all"}
                onChange={(value) => changeFilter("kind", value === "all" ? "" : value)}
                options={[
                  { value: "all", label: t("routesDrive.allTypes") },
                  { value: "folder", label: t("routesDrive.folders") },
                  { value: "file", label: t("routesDrive.files") },
                ]}
              />
              {kind && (
                <Button variant="ghost" size="sm" onClick={() => changeFilter("kind", "")}>
                  {t("common.clear")}
                  <Icon name="close" width="12" height="12" />
                </Button>
              )}
            </div>
            <div className="drive-view-options">
              <Menu.Root>
                <Menu.Trigger
                  render={<Button variant="ghost" size="sm" />}
                  aria-label={t("routesDrive.sortFiles")}
                >
                  <Icon name="sort" />
                  <span>
                    {sort === "name"
                      ? t("common.name")
                      : sort === "size"
                        ? t("routesDrive.size")
                        : view === "recent" && !params.has("sort")
                          ? t("routesDrive.lastOpened")
                          : t("routesDrive.lastModified")}
                  </span>
                  <Icon name="down" width="12" height="12" />
                </Menu.Trigger>
                <MenuPopup data-ui-theme="neutral" positionerProps={{ align: "end" }}>
                  {[
                    { value: "name", label: t("common.name") },
                    { value: "updated_at", label: t("routesDrive.lastModified") },
                    { value: "size", label: t("routesDrive.fileSize") },
                  ].map((option) => (
                    <Menu.Item
                      key={option.value}
                      onClick={() => changeFilter("sort", option.value)}
                    >
                      <Icon name={sort === option.value ? "check" : "circle"} />
                      {option.label}
                    </Menu.Item>
                  ))}
                  <Menu.Separator />
                  <Menu.Item
                    onClick={() => {
                      const next = new URLSearchParams(params);
                      next.set("sort", sort);
                      next.set("order", order === "asc" ? "desc" : "asc");
                      setParams(next);
                    }}
                  >
                    <Icon name="sort" />
                    {order === "asc"
                      ? t("routesDrive.switchToDescending")
                      : t("routesDrive.switchToAscending")}
                  </Menu.Item>
                </MenuPopup>
              </Menu.Root>
              <ToggleGroup
                value={[layout]}
                onValueChange={chooseLayout}
                className="drive-layout-toggle"
                aria-label={t("routesDrive.fileView")}
              >
                <Toggle value="list" data-size="icon" aria-label={t("routesDrive.listView")}>
                  <Icon name="list" />
                </Toggle>
                <Toggle value="grid" data-size="icon" aria-label={t("routesDrive.gridView")}>
                  <Icon name="grid" />
                </Toggle>
              </ToggleGroup>
            </div>
          </div>
          {selection.size > 0 && (
            <div
              className="drive-selection-toolbar"
              role="toolbar"
              aria-label={t("routesDrive.selectedFileActions")}
            >
              <DriveIconButton
                icon="close"
                label={t("routesDrive.clearSelection")}
                onClick={() => {
                  setSelection(new Set());
                  if (mobile) selectionButton.current?.focus();
                }}
              />
              <strong>
                <LocalizedMessage id="routesDrive.selected" values={{ size: selection.size }} />
              </strong>
              {mobile && selectedId && (
                <DriveIconButton
                  icon="sidebar"
                  label={
                    detailsOpen
                      ? t("routesDrive.hideFileInformation")
                      : t("routesDrive.showFileInformation")
                  }
                  aria-pressed={detailsOpen}
                  onClick={() => setDetailsOpen(!detailsOpen)}
                />
              )}
              {view === "trash" ? (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => operate("restore", selected)}
                    disabled={!selected.every((item) => item.actions?.update !== false)}
                  >
                    <Icon name="undo" />
                    {t("routesDrive.restore")}
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => operate("delete", selected)}
                    disabled={!selected.every((item) => item.actions?.delete !== false)}
                  >
                    <Icon name="trash" />
                    {t("routesDrive.deleteForever")}
                  </Button>
                </>
              ) : (
                <>
                  {selected.length === 1 && selected[0]!.effective_role === "owner" && (
                    <DriveIconButton
                      icon="users"
                      label={t("routesDrive.shareSelectedItem")}
                      onClick={() => operate("share", selected)}
                    />
                  )}
                  <DriveIconButton
                    icon="star"
                    label={t("routesDrive.toggleStarred")}
                    disabled={action.busy}
                    onClick={() => operate("star", selected)}
                  />
                  {selected.every(canEdit) && (
                    <DriveIconButton
                      icon="move"
                      label={t("routesDrive.moveSelectedItems")}
                      onClick={() => operate("move", selected)}
                    />
                  )}
                  <DriveIconButton
                    icon="copy"
                    label={t("routesDrive.copySelectedItems")}
                    disabled={!selected.every((item) => item.actions?.copy !== false)}
                    onClick={() => operate("copy", selected)}
                  />
                  {selected.length === 1 && selected[0]!.kind === "file" && (
                    <DriveIconButton
                      icon="download"
                      label={t("routesDrive.downloadSelectedFile")}
                      disabled={action.busy || selected[0]?.actions?.download === false}
                      onClick={() => operate("download", selected)}
                    />
                  )}
                  <span className="drive-toolbar-separator" />
                  {selected.every(
                    (item) => item.effective_role === "owner" && item.actions?.delete !== false,
                  ) && (
                    <DriveIconButton
                      icon="trash"
                      label={t("routesDrive.moveSelectedItemsToTrash")}
                      onClick={() => operate("trash", selected)}
                    />
                  )}
                </>
              )}
              <span className="drive-selection-hint">{t("routesDrive.escToClear")}</span>
            </div>
          )}
        </div>
        <DriveNotice error={action.error} />
        <DriveState
          layout={layout}
          loading={
            collection.loading || (!!folder && folderResource.loading && !folderResource.data)
          }
          error={folderResource.error || (collection.items.length ? "" : collection.error)}
          retry={() => {
            collection.reload();
            folderResource.reload();
          }}
        />
        {empty && !folderResource.error && (
          <div className="drive-empty">
            <div className="drive-empty-art">
              <span />
              <Icon
                name={
                  searching
                    ? "search"
                    : view === "shared"
                      ? "users"
                      : view === "recent"
                        ? "clock"
                        : view === "starred"
                          ? "star"
                          : view === "trash"
                            ? "trash"
                            : "folder"
                }
                width="54"
                height="54"
              />
              <span />
            </div>
            <h2>
              {searching
                ? t("routesDrive.noMatchingFiles")
                : view === "shared"
                  ? t("routesDrive.sharedFilesAppearHere")
                  : view === "recent"
                    ? t("routesDrive.yourRecentFilesAppearHere")
                    : view === "starred"
                      ? t("routesDrive.keepYourFavoritesClose")
                      : view === "trash"
                        ? t("routesDrive.yourTrashIsEmpty")
                        : kind
                          ? t("routesDrive.noItemsOfThisType")
                          : t("routesDrive.aPlaceForEverything")}
            </h2>
            <p>
              {searching
                ? t("routesDrive.tryADifferentNameOrClearYourFilters")
                : view === "shared"
                  ? t("routesDrive.filesAndFoldersSharedWithYourAccountWillAppear")
                  : view === "recent"
                    ? t("routesDrive.openOrPreviewAFileToFindItHere")
                    : view === "starred"
                      ? t("routesDrive.addAStarToFilesAndFoldersYouUse")
                      : view === "trash"
                        ? t("routesDrive.itemsYouDeleteCanBeRestoredHereFor30")
                        : kind
                          ? t("routesDrive.chooseAnotherTypeToSeeMoreFiles")
                          : t("routesDrive.uploadYourFilesOrCreateAFolderToGet")}
            </p>
            {writable && !kind && (
              <Button variant="primary" onClick={() => drive.chooseFiles()}>
                <Icon name="upload" />
                {t("routesDrive.uploadFiles")}
              </Button>
            )}
            {searching && (
              <Button onClick={() => navigate("/drive")}>{t("routesDrive.clearSearch")}</Button>
            )}
          </div>
        )}
        {!collection.loading && !!collection.items.length && (
          <DriveOwnerPhotosProvider>
            <div className={`drive-files-scroll drive-layout-${layout}`}>
              <div
                className="drive-file-grid"
                role="grid"
                aria-label={t("routesDrive.files2", { title: title })}
                aria-multiselectable="true"
              >
                <div className="drive-table-header" role="row">
                  {showCheckboxes && (
                    <div role="columnheader">
                      <DriveCheckbox
                        hitArea
                        aria-label={t("routesDrive.selectAllLoadedItems")}
                        checked={selection.size === collection.items.length && !!selection.size}
                        indeterminate={
                          selection.size > 0 && selection.size < collection.items.length
                        }
                        onCheckedChange={(checked) =>
                          setSelection(
                            checked ? new Set(collection.items.map((item) => item.id)) : new Set(),
                          )
                        }
                      />
                    </div>
                  )}
                  <div role="columnheader">{t("common.name")}</div>
                  <div role="columnheader" className="drive-column-owner">
                    {t("routesDrive.owner2")}
                  </div>
                  <div role="columnheader">
                    {view === "trash"
                      ? t("routesDrive.dateDeleted")
                      : t("routesDrive.lastModified")}
                  </div>
                  <div role="columnheader" className="drive-column-size">
                    {t("routesDrive.fileSize")}
                  </div>
                  <div role="columnheader">
                    <span className="visually-hidden">{t("common.actions")}</span>
                  </div>
                </div>
                {collection.items.map((item, index) => (
                  <Fragment key={item.id}>
                    {layout === "grid" &&
                      item.kind === "file" &&
                      index > 0 &&
                      collection.items[index - 1]?.kind === "folder" && (
                        <div className="drive-grid-section-label" role="presentation">
                          {t("routesDrive.files")}
                        </div>
                      )}
                    <ContextMenu.Root>
                      <ContextMenu.Trigger
                        render={
                          <div
                            role="row"
                            tabIndex={0}
                            className={`drive-file-row${selection.has(item.id) ? " is-selected" : ""}`}
                            aria-selected={selection.has(item.id)}
                          />
                        }
                        onContextMenu={() => {
                          if (!selection.has(item.id)) setSelection(new Set([item.id]));
                        }}
                        onClick={(event) => {
                          if (
                            !(event.target as HTMLElement).closest(
                              'button,input,[role="checkbox"],[data-ui="checkbox-hit-area"],[data-ui="menu-popup"],[data-ui="context-menu-popup"]',
                            )
                          ) {
                            if (selecting) toggleSelected(item);
                            else if (mobile) open(item);
                            else select(item, event);
                          }
                        }}
                        onDoubleClick={(event) => {
                          if (
                            !(event.target as HTMLElement).closest(
                              'button,input,[role="checkbox"],[data-ui="checkbox-hit-area"],[data-ui="menu-popup"],[data-ui="context-menu-popup"]',
                            )
                          )
                            if (!selecting) open(item);
                        }}
                        onKeyDown={(event) => {
                          if (event.target === event.currentTarget && event.key === "Enter") {
                            event.preventDefault();
                            if (selecting) toggleSelected(item);
                            else open(item);
                          }
                          if (event.target === event.currentTarget && event.key === " ") {
                            event.preventDefault();
                            toggleSelected(item);
                          }
                        }}
                      >
                        {showCheckboxes && (
                          <div className="drive-row-select" role="gridcell">
                            <DriveCheckbox
                              hitArea
                              aria-label={t("routesDrive.select2", { name: item.name })}
                              checked={selection.has(item.id)}
                              onCheckedChange={(checked) => {
                                if (mobile) setSelectionMode(true);
                                setSelection((old) => {
                                  const next = new Set(old);
                                  checked ? next.add(item.id) : next.delete(item.id);
                                  return next;
                                });
                                anchor.current = item.id;
                              }}
                            />
                          </div>
                        )}
                        <div className="drive-row-name" role="gridcell">
                          <DriveFileIcon item={item} />
                          <Button
                            variant="text"
                            className="drive-name-button"
                            onClick={(event) => {
                              if (selecting) toggleSelected(item);
                              else if (mobile || event.detail === 0) open(item);
                              else select(item, event);
                            }}
                            onDoubleClick={() => {
                              if (!selecting) open(item);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                if (selecting) toggleSelected(item);
                                else open(item);
                              }
                            }}
                            title={item.name}
                          >
                            {item.name}
                          </Button>
                          {item.starred && <Icon name="star" className="drive-starred-icon" />}
                          {item.owner_user_id !== item.owner?.id
                            ? null
                            : item.effective_role !== "owner" && (
                                <Icon name="users" className="drive-shared-icon" />
                              )}
                        </div>
                        {item.kind === "file" && (
                          <div className="drive-card-preview" aria-hidden="true">
                            <DriveFileIcon item={item} large />
                            <span>{fileKind(item).label}</span>
                          </div>
                        )}
                        <div className="drive-row-owner" role="gridcell">
                          <DriveOwner item={item} />
                        </div>
                        <div className="drive-row-date" role="gridcell">
                          {driveDate(view === "trash" ? item.trashed_at! : item.updated_at)}
                        </div>
                        <div className="drive-row-size" role="gridcell">
                          {item.kind === "folder" ? "—" : formatBytes(driveSize(item))}
                        </div>
                        <div className="drive-row-menu" role="gridcell">
                          <DriveItemMenu
                            item={item}
                            trash={view === "trash"}
                            onAction={(name) => operate(name, [item])}
                          />
                        </div>
                      </ContextMenu.Trigger>
                      <ContextMenuPopup data-ui-theme="neutral">
                        <DriveMenuItems
                          item={item}
                          trash={view === "trash"}
                          context
                          onAction={(name) => operate(name, [item])}
                        />
                      </ContextMenuPopup>
                    </ContextMenu.Root>
                  </Fragment>
                ))}
              </div>
              <footer className="drive-list-footer">
                <span>
                  {plural(
                    collection.next ? "counts.loadedItems" : "counts.items",
                    collection.items.length,
                  )}
                </span>
                <span>{t("routesDrive.singleClickToSelectDoubleClickToOpen")}</span>
              </footer>
              {collection.next && (
                <div className="drive-load-more">
                  <Button onClick={() => void collection.loadMore()} disabled={collection.more}>
                    {collection.more ? t("common.loading") : t("routesDrive.loadMoreFiles")}
                  </Button>
                </div>
              )}
              <DriveNotice error={collection.items.length ? collection.error : ""} />
            </div>
          </DriveOwnerPhotosProvider>
        )}
      </div>
      {detailsOpen && selectedId && (
        <>
          {detailItem ? (
            <DriveDetails
              key={detailItem.id}
              item={detailItem}
              onClose={() => setDetailsOpen(false)}
              onShare={() => operate("share", [detailItem])}
              onOpen={() => open(detailItem)}
            />
          ) : (
            <aside className="drive-details">
              <DriveIconButton
                icon="close"
                label={t("routesDrive.closeFileInformation")}
                onClick={() => setDetailsOpen(false)}
              />
              <DriveState
                loading={selectedResource.loading}
                error={selectedResource.error}
                retry={selectedResource.reload}
              />
            </aside>
          )}
        </>
      )}
      {dragging && (
        <div className="drive-drop-overlay">
          <Icon name="upload" width="44" height="44" />
          <strong>
            {writable
              ? t("routesDrive.dropFilesToUpload", {
                  value1: folder ? t("routesDrive.to", { title: title }) : "",
                })
              : t("routesDrive.openAWritableFolderToUpload")}
          </strong>
          <span>
            {writable
              ? t("routesDrive.filesAreStoredSecurelyInYourWorkspace")
              : t("routesDrive.youCanUploadInMyDriveOrAFolder")}
          </span>
        </div>
      )}
      {preview && (
        <DrivePreview
          item={preview}
          canDownload={preview.actions?.download !== false}
          canPreview={
            preview.actions?.download !== false ||
            [
              "text/plain",
              "application/pdf",
              "image/jpeg",
              "image/png",
              "image/gif",
              "image/webp",
              "image/avif",
            ].includes(preview.current_version?.content_type ?? preview.content_type ?? "")
          }
          onClose={() => setPreview(null)}
          onShare={
            preview.effective_role === "owner"
              ? () => {
                  setDialog({ type: "share", items: [preview] });
                  setPreview(null);
                }
              : undefined
          }
        />
      )}
      {dialog?.type === "rename" && (
        <DriveRenameDialog item={dialog.items[0]!} onClose={() => setDialog(null)} />
      )}
      {dialog?.type === "share" && (
        <DriveShareDialog item={dialog.items[0]!} onClose={() => setDialog(null)} />
      )}
      {(dialog?.type === "move" || dialog?.type === "copy") && (
        <DriveDestinationDialog
          items={dialog.items}
          copy={dialog.type === "copy"}
          onClose={() => setDialog(null)}
        />
      )}
      {(dialog?.type === "trash" || dialog?.type === "delete") && (
        <DriveConfirmDialog
          title={
            dialog.type === "delete"
              ? t("routesDrive.deleteForever2")
              : t("routesDrive.moveToTrash")
          }
          description={`${dialog.items.length === 1 ? `“${dialog.items[0]!.name}”` : t("routesDrive.selectedItems", { length: dialog.items.length })}${dialog.items.some((item) => item.kind === "folder") ? t("routesDrive.andAnyFolderContents") : ""} ${dialog.type === "delete" ? t("routesDrive.willBePermanentlyDeletedThisCannotBeUndone") : t("routesDrive.willBeMovedToTrashYouCanRestoreThem")}`}
          confirm={
            dialog.type === "delete"
              ? t("routesDrive.deleteForever")
              : t("routesDrive.moveToTrash2")
          }
          destructive
          onClose={() => setDialog(null)}
          action={trashOperation}
        />
      )}
    </section>
  );
}
function DriveItemMenu({
  item,
  trash,
  onAction,
}: {
  item: DriveItem;
  trash: boolean;
  onAction: (name: ItemAction) => void;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        render={<Button size="icon" variant="ghost" />}
        aria-label={t("routesDrive.actionsFor", { name: item.name })}
      >
        <Icon name="more" />
      </Menu.Trigger>
      <MenuPopup data-ui-theme="neutral" positionerProps={{ align: "end" }}>
        <DriveMenuItems item={item} trash={trash} onAction={onAction} />
      </MenuPopup>
    </Menu.Root>
  );
}
function DriveMenuItems({
  item,
  trash,
  context = false,
  onAction,
}: {
  item: DriveItem;
  trash: boolean;
  context?: boolean;
  onAction: (name: ItemAction) => void;
}) {
  const Item = context ? ContextMenu.Item : Menu.Item,
    Separator = context ? ContextMenu.Separator : Menu.Separator;
  return trash ? (
    <>
      <Item disabled={item.actions?.update === false} onClick={() => onAction("restore")}>
        <Icon name="undo" />
        {t("routesDrive.restore")}
      </Item>
      <Item onClick={() => onAction("details")}>
        <Icon name="info" />
        {t("routesDrive.fileInformation")}
      </Item>
      <Separator />
      <Item
        disabled={item.actions?.delete === false}
        data-variant="danger"
        onClick={() => onAction("delete")}
      >
        <Icon name="trash" />
        {t("routesDrive.deleteForever")}
      </Item>
    </>
  ) : (
    <>
      <Item onClick={() => onAction("open")}>
        <Icon name={item.kind === "folder" ? "folder" : "eye"} />
        {item.kind === "folder" ? t("routesDrive.openFolder") : t("routesDrive.preview")}
      </Item>
      {item.effective_role === "owner" && (
        <Item onClick={() => onAction("share")}>
          <Icon name="users" />
          {t("routesDrive.share")}
        </Item>
      )}
      {item.kind === "file" && item.actions?.download !== false && (
        <Item onClick={() => onAction("download")}>
          <Icon name="download" />
          {t("routesDrive.download")}
        </Item>
      )}
      <Separator />
      {canEdit(item) && (
        <>
          <Item onClick={() => onAction("rename")}>
            <Icon name="edit" />
            {t("routesDrive.rename")}
          </Item>
          <Item onClick={() => onAction("move")}>
            <Icon name="move" />
            {t("routesDrive.moveTo")}
          </Item>
        </>
      )}
      <Item disabled={item.actions?.copy === false} onClick={() => onAction("copy")}>
        <Icon name="copy" />
        {t("routesDrive.makeACopy")}
      </Item>
      <Item onClick={() => onAction("star")}>
        <Icon name="star" />
        {item.starred ? t("routesDrive.removeFromStarred") : t("routesDrive.addToStarred")}
      </Item>
      <Item onClick={() => onAction("details")}>
        <Icon name="info" />
        {t("routesDrive.fileInformation")}
      </Item>
      {item.effective_role === "owner" && (
        <>
          <Separator />
          <Item
            disabled={item.actions?.delete === false}
            data-variant="danger"
            onClick={() => onAction("trash")}
          >
            <Icon name="trash" />
            {t("routesDrive.moveToTrash2")}
          </Item>
        </>
      )}
    </>
  );
}

export function DriveLinkedItemPage() {
  const location = useLocation(),
    navigate = useNavigate(),
    drive = useDrive(),
    id = location.pathname.split("/").at(-1)!,
    resource = useDriveResource<{ item: DriveItem }>(`/api/drive/items/${id}`, drive.revision),
    action = useDriveAction();
  const [message, setMessage] = useState(""),
    [role, setRole] = useState("viewer"),
    [sent, setSent] = useState(false);
  useEffect(() => {
    if (resource.data?.item.kind === "folder") navigate(`/drive/folders/${id}`, { replace: true });
  }, [resource.data, id, navigate]);
  if (resource.data?.item.kind === "file") return <DrivePage linkedItem={resource.data.item} />;
  return (
    <section className="drive-linked-state">
      <DriveState loading={resource.loading} error={resource.error} retry={resource.reload} />
      {resource.error && (
        <div className="drive-access-request-form">
          <h2>{t("routesDrive.requestAccess")}</h2>
          <p>{t("routesDrive.theOwnerCanGiveYourAccountAccessToThis")}</p>
          {sent ? (
            <p role="status">{t("routesDrive.ifThisItemIsAvailableTheOwnerWillReceive")}</p>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void action.run(async () => {
                  await api(`/api/drive/items/${id}/access-requests`, {
                    method: "POST",
                    body: { role, message },
                  });
                  setSent(true);
                });
              }}
            >
              <DriveSelect
                label={t("routesDrive.requestedAccess")}
                value={role}
                options={[
                  { value: "viewer", label: t("routesDrive.viewer") },
                  { value: "commenter", label: t("routesDrive.commenter") },
                  { value: "editor", label: t("routesDrive.editor") },
                ]}
                onChange={setRole}
              />
              <DriveField
                label={t("routesDrive.messageOptional")}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                maxLength={1000}
              />
              <Button variant="primary" type="submit" disabled={action.busy}>
                {t("routesDrive.requestAccess")}
              </Button>
            </form>
          )}
          <DriveNotice error={action.error} />
          <Link to="/drive">{t("routesDrive.returnToMyDrive")}</Link>
        </div>
      )}
    </section>
  );
}
