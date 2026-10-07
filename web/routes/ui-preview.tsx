import { useRef, useState } from "react";
import { Link } from "react-router";
import { Accordion, AlertDialog, AlertDialogPopup, Button, Checkbox, Combobox, ComboboxPopup,
  Dialog, DialogPopup, Field, Form, Menu, MenuPopup, Popover, PopoverPopup, Select, SelectPopup,
  Tabs, TextField, Tooltip, TooltipPopup } from "@/components/ui";

const roles = ["Reader", "Editor", "Administrator"];
const apps = ["Calendar", "Files", "Mail"];

// Loaded only by the development router; this page does not call account APIs.
export default function UIPreviewPage() {
  const [result, setResult] = useState("");
  const input = useRef<HTMLInputElement>(null);

  return (
    <main>
      <h1>UI components</h1>
      <p>Unstyled component preview for keyboard, focus and form behavior.</p>
      <Link to="/login">Go to sign in</Link>

      <section aria-labelledby="form-heading">
        <h2 id="form-heading">Form controls</h2>
        <Form onFormSubmit={() => setResult("Form submitted")}>
          <TextField ref={input} name="email" label="Email" type="email" required
            description="Enter an email address to test validation." />
          <Field.Root name="role">
            <Select.Root items={roles.map((role) => ({ value: role, label: role }))} defaultValue="Reader">
              <Select.Label>Role</Select.Label>
              {" "}
              <Select.Trigger><Select.Value /></Select.Trigger>
              <SelectPopup>
                <Select.List>
                  {roles.map((role) => <Select.Item key={role} value={role}>
                    <Select.ItemText>{role}</Select.ItemText>
                  </Select.Item>)}
                </Select.List>
              </SelectPopup>
            </Select.Root>
          </Field.Root>
          <Field.Root name="app">
            <Field.Label>Application</Field.Label>
            {" "}
            <Combobox.Root items={apps}>
              <Combobox.Input />
              <Combobox.Trigger aria-label="Show applications">Show applications</Combobox.Trigger>
              <ComboboxPopup>
                <Combobox.Empty>No applications found</Combobox.Empty>
                <Combobox.List>
                  {(app: string) => <Combobox.Item key={app} value={app}>{app}</Combobox.Item>}
                </Combobox.List>
              </ComboboxPopup>
            </Combobox.Root>
          </Field.Root>
          <Field.Root name="notifications">
            <Field.Label>
              <Checkbox.Root><Checkbox.Indicator aria-hidden="true">✓</Checkbox.Indicator></Checkbox.Root>
              {" "}Enable notifications
            </Field.Label>
          </Field.Root>
          <p>
            <Button type="submit">Submit preview form</Button>
            {" "}
            <Button onClick={() => input.current?.focus()}>Focus email</Button>
          </p>
        </Form>
      </section>

      <section aria-labelledby="popups-heading">
        <h2 id="popups-heading">Popups</h2>
        <Dialog.Root>
          <Dialog.Trigger render={<Button />}>Open dialog</Dialog.Trigger>
          <DialogPopup portalProps={{ keepMounted: true }}>
            <Dialog.Title>Example dialog</Dialog.Title>
            <Dialog.Description>Tab stays in this dialog. Escape closes it and restores focus.</Dialog.Description>
            <TextField label="Display name" name="display_name" />
            <Dialog.Close render={<Button />}>Close dialog</Dialog.Close>
          </DialogPopup>
        </Dialog.Root>
        {" "}
        <AlertDialog.Root>
          <AlertDialog.Trigger render={<Button />}>Open confirmation</AlertDialog.Trigger>
          <AlertDialogPopup>
            <AlertDialog.Title>Confirm preview action</AlertDialog.Title>
            <AlertDialog.Description>This example does not change any data.</AlertDialog.Description>
            <AlertDialog.Close render={<Button />}>Cancel</AlertDialog.Close>
            {" "}
            <AlertDialog.Close render={<Button />} onClick={() => setResult("Preview action confirmed")}>Confirm</AlertDialog.Close>
          </AlertDialogPopup>
        </AlertDialog.Root>
        {" "}
        <Popover.Root>
          <Popover.Trigger render={<Button />}>Open popover</Popover.Trigger>
          <PopoverPopup>
            <Popover.Title>Example popover</Popover.Title>
            <Popover.Description>Use a popover for additional information that needs to be accessible.</Popover.Description>
            <Popover.Close render={<Button />}>Close popover</Popover.Close>
          </PopoverPopup>
        </Popover.Root>
        {" "}
        <Menu.Root>
          <Menu.Trigger render={<Button />}>Open actions</Menu.Trigger>
          <MenuPopup>
            <Menu.Item onClick={() => setResult("First action selected")}>First action</Menu.Item>
            <Menu.Item onClick={() => setResult("Second action selected")}>Second action</Menu.Item>
          </MenuPopup>
        </Menu.Root>
        {" "}
        <Tooltip.Root>
          <Tooltip.Trigger render={<Button />} aria-label="Help">Help</Tooltip.Trigger>
          <TooltipPopup>Help</TooltipPopup>
        </Tooltip.Root>
      </section>

      <section aria-labelledby="navigation-heading">
        <h2 id="navigation-heading">Navigation and disclosure</h2>
        <Tabs.Root defaultValue="profile">
          <Tabs.List>
            <Tabs.Tab value="profile">Profile</Tabs.Tab>
            <Tabs.Tab value="security">Security</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="profile">Profile panel</Tabs.Panel>
          <Tabs.Panel value="security">Security panel</Tabs.Panel>
        </Tabs.Root>
        <Accordion.Root>
          <Accordion.Item value="details">
            <Accordion.Header><Accordion.Trigger>More details</Accordion.Trigger></Accordion.Header>
            <Accordion.Panel>Disclosure content</Accordion.Panel>
          </Accordion.Item>
        </Accordion.Root>
      </section>

      <p role="status">{result}</p>
    </main>
  );
}
