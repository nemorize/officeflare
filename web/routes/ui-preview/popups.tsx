import { t } from "../../../shared/i18n/index.ts";
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogPopup,
  Button,
  ContextMenu,
  ContextMenuPopup,
  Dialog,
  DialogPopup,
  Drawer,
  DrawerPopup,
  Menu,
  MenuPopup,
  Popover,
  PopoverPopup,
  PreviewCard,
  PreviewCardPopup,
  TextField,
  Toast,
  Tooltip,
  TooltipPopup,
} from "@/components/ui";

export function DialogDemo() {
  return (
    <Dialog.Root>
      <Dialog.Trigger render={<Button />}>{t("routesUiPreviewPopups.openDialog")}</Dialog.Trigger>
      <DialogPopup portalProps={{ keepMounted: true }}>
        <Dialog.Title>{t("routesUiPreviewPopups.exampleDialog")}</Dialog.Title>
        <Dialog.Description>
          {t("routesUiPreviewPopups.tabStaysInThisDialogEscapeClosesItAnd")}
        </Dialog.Description>
        <TextField
          label={t("routesUiPreviewPopups.dialogDisplayName")}
          name="preview-dialog-name"
        />
        <Dialog.Close render={<Button />}>{t("routesUiPreviewPopups.closeDialog")}</Dialog.Close>
      </DialogPopup>
    </Dialog.Root>
  );
}

export function AlertDialogDemo() {
  const [result, setResult] = useState("");
  return (
    <>
      <AlertDialog.Root>
        <AlertDialog.Trigger render={<Button />}>
          {t("routesUiPreviewPopups.openConfirmation")}
        </AlertDialog.Trigger>
        <AlertDialogPopup>
          <AlertDialog.Title>{t("routesUiPreviewPopups.confirmPreviewAction")}</AlertDialog.Title>
          <AlertDialog.Description>
            {t("routesUiPreviewPopups.thisExampleOnlyUpdatesLocalDemoState")}
          </AlertDialog.Description>
          <AlertDialog.Close render={<Button />}>{t("common.cancel")}</AlertDialog.Close>{" "}
          <AlertDialog.Close
            render={<Button variant="primary" />}
            onClick={() => setResult(t("routesUiPreviewPopups.previewActionConfirmed"))}
          >
            {t("routesUiPreviewPopups.confirm")}
          </AlertDialog.Close>
        </AlertDialogPopup>
      </AlertDialog.Root>
      <p role="status">{result}</p>
    </>
  );
}

export function DrawerDemo() {
  return (
    <Drawer.Provider>
      <Drawer.Root swipeDirection="down">
        <Drawer.Trigger render={<Button />}>{t("routesUiPreviewPopups.openDrawer")}</Drawer.Trigger>
        <DrawerPopup>
          <Drawer.Title>{t("routesUiPreviewPopups.exampleDrawer")}</Drawer.Title>
          <Drawer.Description>
            {t("routesUiPreviewPopups.swipeDownToDismissOrUseTheCloseButton")}
          </Drawer.Description>
          <p>{t("routesUiPreviewPopups.selectableDrawerContent")}</p>
          <Drawer.Close render={<Button />}>{t("routesUiPreviewPopups.closeDrawer")}</Drawer.Close>
        </DrawerPopup>
      </Drawer.Root>
    </Drawer.Provider>
  );
}

export function PopoverDemo() {
  return (
    <Popover.Root>
      <Popover.Trigger render={<Button />}>
        {t("routesUiPreviewPopups.openPopover")}
      </Popover.Trigger>
      <PopoverPopup>
        <Popover.Title>{t("routesUiPreviewPopups.examplePopover")}</Popover.Title>
        <Popover.Description>
          {t("routesUiPreviewPopups.supplementaryInformationWithAccessibleContent")}
        </Popover.Description>
        <Popover.Close render={<Button />}>{t("routesUiPreviewPopups.closePopover")}</Popover.Close>
      </PopoverPopup>
    </Popover.Root>
  );
}

export function MenuDemo() {
  const [result, setResult] = useState("");
  return (
    <>
      <Menu.Root>
        <Menu.Trigger render={<Button />}>{t("routesUiPreviewPopups.openActions")}</Menu.Trigger>
        <MenuPopup>
          <Menu.Item onClick={() => setResult(t("routesUiPreviewPopups.firstActionSelected"))}>
            {t("routesUiPreviewPopups.firstAction")}
          </Menu.Item>
          <Menu.Item onClick={() => setResult(t("routesUiPreviewPopups.secondActionSelected"))}>
            {t("routesUiPreviewPopups.secondAction")}
          </Menu.Item>
        </MenuPopup>
      </Menu.Root>
      <p role="status">{result}</p>
    </>
  );
}

export function ContextMenuDemo() {
  const [result, setResult] = useState("");
  const copy = () => setResult(t("routesUiPreviewPopups.previewItemCopied"));
  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger render={<Button />} onClick={copy}>
          {t("routesUiPreviewPopups.previewItemClickToCopyOrRightClickFor")}
        </ContextMenu.Trigger>
        <ContextMenuPopup>
          <ContextMenu.Item onClick={copy}>
            {t("routesUiPreviewPopups.copyPreviewItem")}
          </ContextMenu.Item>
          <ContextMenu.Item
            onClick={() => setResult(t("routesUiPreviewPopups.previewItemRenamed"))}
          >
            {t("routesUiPreviewPopups.renamePreviewItem")}
          </ContextMenu.Item>
        </ContextMenuPopup>
      </ContextMenu.Root>
      <Button onClick={() => setResult(t("routesUiPreviewPopups.previewItemRenamed"))}>
        {t("routesUiPreviewPopups.renamePreviewItem")}
      </Button>
      <p role="status">{result}</p>
    </>
  );
}

export function PreviewCardDemo() {
  return (
    <>
      <PreviewCard.Root>
        <PreviewCard.Trigger href="#preview-card-details">
          {t("routesUiPreviewPopups.previewSampleMember")}
        </PreviewCard.Trigger>
        <PreviewCardPopup>
          <PreviewCard.Viewport>
            <p>{t("routesUiPreviewPopups.alexMorganExampleMemberAvailableInTheDirectory")}</p>
          </PreviewCard.Viewport>
        </PreviewCardPopup>
      </PreviewCard.Root>
      <p id="preview-card-details">
        {t("routesUiPreviewPopups.alexMorganExampleMemberAvailableInTheDirectory")}
      </p>
    </>
  );
}

export function TooltipDemo() {
  return (
    <>
      <Tooltip.Root>
        <Tooltip.Trigger render={<Button />} aria-label={t("routesUiPreviewPopups.help")}>
          {t("routesUiPreviewPopups.help")}
        </Tooltip.Trigger>
        <TooltipPopup>{t("routesUiPreviewPopups.help")}</TooltipPopup>
      </Tooltip.Root>
      <p>{t("routesUiPreviewPopups.theButtonHasAnAccessibleNameEvenWhenIts")}</p>
    </>
  );
}

function ToastContents() {
  const manager = Toast.useToastManager();
  return (
    <>
      <Button
        onClick={() =>
          manager.add({
            title: t("routesUiPreviewPopups.previewNotification"),
            description: t("routesUiPreviewPopups.dismissThisExampleNotification"),
            timeout: 0,
          })
        }
      >
        {t("routesUiPreviewPopups.showNotification")}
      </Button>
      <Button
        variant="danger"
        onClick={() =>
          manager.add({
            title: t("routesUiPreviewPopups.unableToSaveChanges"),
            description: t("routesUiPreviewPopups.tryAgainInAMoment"),
            type: "error",
            timeout: 0,
          })
        }
      >
        {t("routesUiPreviewPopups.showErrorNotification")}
      </Button>
      <Toast.Portal>
        <Toast.Viewport aria-label={t("common.notifications")} data-ui="toast-viewport">
          {manager.toasts.map((toast) => (
            <Toast.Root key={toast.id} toast={toast}>
              <Toast.Content>
                <Toast.Title />
                <Toast.Description />
                <Toast.Close
                  render={<Button />}
                  aria-label={t("routesUiPreviewPopups.dismissNotification")}
                >
                  {t("routesUiPreviewPopups.dismiss")}
                </Toast.Close>
              </Toast.Content>
            </Toast.Root>
          ))}
        </Toast.Viewport>
      </Toast.Portal>
    </>
  );
}

export function ToastDemo() {
  return (
    <Toast.Provider limit={3}>
      <ToastContents />
    </Toast.Provider>
  );
}
