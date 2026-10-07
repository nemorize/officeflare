import { useState } from "react";
import { Accordion, Button, Collapsible, Menu, MenuPopup, Menubar, NavigationMenu,
  NavigationMenuPopup, Tabs, Toolbar } from "@/components/ui";

export function AccordionDemo() {
  return <Accordion.Root>
    {["Profile", "Security"].map((label) => <Accordion.Item key={label} value={label}>
      <Accordion.Header render={<h4 />}><Accordion.Trigger>{label} details</Accordion.Trigger></Accordion.Header>
      <Accordion.Panel>{label} disclosure content</Accordion.Panel>
    </Accordion.Item>)}
  </Accordion.Root>;
}

export function CollapsibleDemo() {
  return <Collapsible.Root>
    <Collapsible.Trigger render={<Button />}>Toggle additional details</Collapsible.Trigger>
    <Collapsible.Panel>Additional account details</Collapsible.Panel>
  </Collapsible.Root>;
}

export function TabsDemo() {
  return <Tabs.Root defaultValue="profile">
    <Tabs.List aria-label="Account sections">
      <Tabs.Tab value="profile">Profile</Tabs.Tab>
      <Tabs.Tab value="security">Security</Tabs.Tab>
    </Tabs.List>
    <Tabs.Panel value="profile">Profile panel</Tabs.Panel>
    <Tabs.Panel value="security">Security panel</Tabs.Panel>
  </Tabs.Root>;
}

export function MenubarDemo() {
  const [result, setResult] = useState("");
  return <>
    <Menubar aria-label="Example application menu">
      {["File", "Edit"].map((name) => <Menu.Root key={name}>
        <Menu.Trigger>{name}</Menu.Trigger>
        <MenuPopup>
          <Menu.Item onClick={() => setResult(`${name} action selected`)}>{name} action</Menu.Item>
          <Menu.Item disabled>Unavailable action</Menu.Item>
        </MenuPopup>
      </Menu.Root>)}
    </Menubar>
    <p role="status">{result}</p>
  </>;
}

export function NavigationMenuDemo() {
  return <>
    <NavigationMenu.Root aria-label="Example navigation">
      <NavigationMenu.List>
        <NavigationMenu.Item>
          <NavigationMenu.Trigger>Components</NavigationMenu.Trigger>
          <NavigationMenu.Content>
            <NavigationMenu.Link href="#preview-nav-directory">Directory example</NavigationMenu.Link>{" "}
            <NavigationMenu.Link href="#preview-nav-settings">Settings example</NavigationMenu.Link>
          </NavigationMenu.Content>
        </NavigationMenu.Item>
        <NavigationMenu.Item>
          <NavigationMenu.Link href="#preview-nav-directory">Directory home</NavigationMenu.Link>
        </NavigationMenu.Item>
      </NavigationMenu.List>
      <NavigationMenuPopup><NavigationMenu.Viewport /></NavigationMenuPopup>
    </NavigationMenu.Root>
    <p id="preview-nav-directory">Example directory destination</p>
    <p id="preview-nav-settings">Example settings destination</p>
  </>;
}

export function ToolbarDemo() {
  const [result, setResult] = useState("");
  return <>
    <Toolbar.Root aria-label="Example editor toolbar">
      <Toolbar.Group aria-label="Editing actions">
        <Toolbar.Button onClick={() => setResult("Undo selected")}>Undo</Toolbar.Button>
        <Toolbar.Button onClick={() => setResult("Redo selected")}>Redo</Toolbar.Button>
      </Toolbar.Group>
      <Toolbar.Separator />
      <Toolbar.Link href="#preview-toolbar-document">Go to document</Toolbar.Link>
      <Toolbar.Input aria-label="Find in document" placeholder="Find in document" />
    </Toolbar.Root>
    <p role="status">{result}</p>
    <p id="preview-toolbar-document">Example document</p>
  </>;
}
