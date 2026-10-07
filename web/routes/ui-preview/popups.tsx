import { useState } from "react";
import { AlertDialog, AlertDialogPopup, Button, ContextMenu, ContextMenuPopup, Dialog, DialogPopup,
  Drawer, DrawerPopup, Menu, MenuPopup, Popover, PopoverPopup, PreviewCard, PreviewCardPopup,
  TextField, Toast, Tooltip, TooltipPopup } from "@/components/ui";

export function DialogDemo() {
  return <Dialog.Root>
    <Dialog.Trigger render={<Button />}>Open dialog</Dialog.Trigger>
    <DialogPopup portalProps={{ keepMounted: true }}>
      <Dialog.Title>Example dialog</Dialog.Title>
      <Dialog.Description>Tab stays in this dialog. Escape closes it and restores focus.</Dialog.Description>
      <TextField label="Dialog display name" name="preview-dialog-name" />
      <Dialog.Close render={<Button />}>Close dialog</Dialog.Close>
    </DialogPopup>
  </Dialog.Root>;
}

export function AlertDialogDemo() {
  const [result, setResult] = useState("");
  return <>
    <AlertDialog.Root>
      <AlertDialog.Trigger render={<Button />}>Open confirmation</AlertDialog.Trigger>
      <AlertDialogPopup>
        <AlertDialog.Title>Confirm preview action</AlertDialog.Title>
        <AlertDialog.Description>This example only updates local demo state.</AlertDialog.Description>
        <AlertDialog.Close render={<Button />}>Cancel</AlertDialog.Close>{" "}
        <AlertDialog.Close render={<Button variant="primary" />} onClick={() => setResult("Preview action confirmed")}>Confirm</AlertDialog.Close>
      </AlertDialogPopup>
    </AlertDialog.Root>
    <p role="status">{result}</p>
  </>;
}

export function DrawerDemo() {
  return <Drawer.Provider>
    <Drawer.Root swipeDirection="down">
      <Drawer.Trigger render={<Button />}>Open drawer</Drawer.Trigger>
      <DrawerPopup>
        <Drawer.Title>Example drawer</Drawer.Title>
        <Drawer.Description>Swipe down to dismiss, or use the close button.</Drawer.Description>
        <p>Selectable drawer content.</p>
        <Drawer.Close render={<Button />}>Close drawer</Drawer.Close>
      </DrawerPopup>
    </Drawer.Root>
  </Drawer.Provider>;
}

export function PopoverDemo() {
  return <Popover.Root>
    <Popover.Trigger render={<Button />}>Open popover</Popover.Trigger>
    <PopoverPopup>
      <Popover.Title>Example popover</Popover.Title>
      <Popover.Description>Supplementary information with accessible content.</Popover.Description>
      <Popover.Close render={<Button />}>Close popover</Popover.Close>
    </PopoverPopup>
  </Popover.Root>;
}

export function MenuDemo() {
  const [result, setResult] = useState("");
  return <>
    <Menu.Root>
      <Menu.Trigger render={<Button />}>Open actions</Menu.Trigger>
      <MenuPopup>
        <Menu.Item onClick={() => setResult("First action selected")}>First action</Menu.Item>
        <Menu.Item onClick={() => setResult("Second action selected")}>Second action</Menu.Item>
      </MenuPopup>
    </Menu.Root>
    <p role="status">{result}</p>
  </>;
}

export function ContextMenuDemo() {
  const [result, setResult] = useState("");
  const copy = () => setResult("Preview item copied");
  return <>
    <ContextMenu.Root>
      <ContextMenu.Trigger render={<Button />} onClick={copy}>
        Preview item: click to copy, or right-click for actions
      </ContextMenu.Trigger>
      <ContextMenuPopup>
        <ContextMenu.Item onClick={copy}>Copy preview item</ContextMenu.Item>
        <ContextMenu.Item onClick={() => setResult("Preview item renamed")}>Rename preview item</ContextMenu.Item>
      </ContextMenuPopup>
    </ContextMenu.Root>
    <Button onClick={() => setResult("Preview item renamed")}>Rename preview item</Button>
    <p role="status">{result}</p>
  </>;
}

export function PreviewCardDemo() {
  return <>
    <PreviewCard.Root>
      <PreviewCard.Trigger href="#preview-card-details">Preview sample member</PreviewCard.Trigger>
      <PreviewCardPopup><PreviewCard.Viewport>
        <p>Alex Morgan — example member, available in the directory.</p>
      </PreviewCard.Viewport></PreviewCardPopup>
    </PreviewCard.Root>
    <p id="preview-card-details">Alex Morgan — example member, available in the directory.</p>
  </>;
}

export function TooltipDemo() {
  return <>
    <Tooltip.Root>
      <Tooltip.Trigger render={<Button />} aria-label="Help">Help</Tooltip.Trigger>
      <TooltipPopup>Help</TooltipPopup>
    </Tooltip.Root>
    <p>The button has an accessible name even when its tooltip is closed.</p>
  </>;
}

function ToastContents() {
  const manager = Toast.useToastManager();
  return <>
    <Button onClick={() => manager.add({ title: "Preview notification", description: "Dismiss this example notification.", timeout: 0 })}>
      Show notification
    </Button>
    <Button variant="danger" onClick={() => manager.add({ title: "Unable to save changes", description: "Try again in a moment.", type: "error", timeout: 0 })}>
      Show error notification
    </Button>
    <Toast.Portal>
      <Toast.Viewport data-ui="toast-viewport">
        {manager.toasts.map((toast) => <Toast.Root key={toast.id} toast={toast}>
          <Toast.Content>
            <Toast.Title />
            <Toast.Description />
            <Toast.Close render={<Button />} aria-label="Dismiss notification">Dismiss</Toast.Close>
          </Toast.Content>
        </Toast.Root>)}
      </Toast.Viewport>
    </Toast.Portal>
  </>;
}

export function ToastDemo() {
  return <Toast.Provider limit={3}><ToastContents /></Toast.Provider>;
}
