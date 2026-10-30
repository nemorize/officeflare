import { LocalizedMessage } from "../../components/i18n";
import { t } from "../../../shared/i18n/index.ts";
import { useState } from "react";
import {
  Accordion,
  Button,
  Collapsible,
  Menu,
  MenuPopup,
  Menubar,
  NavigationMenu,
  NavigationMenuPopup,
  Tabs,
  Toolbar,
} from "@/components/ui";

export function AccordionDemo() {
  return (
    <Accordion.Root>
      {[t("routesUiPreviewNavigation.profile"), t("routesUiPreviewNavigation.security")].map(
        (label) => (
          <Accordion.Item key={label} value={label}>
            <Accordion.Header render={<h4 />}>
              <Accordion.Trigger>
                <LocalizedMessage
                  id="routesUiPreviewNavigation.details"
                  values={{ label: label }}
                />
              </Accordion.Trigger>
            </Accordion.Header>
            <Accordion.Panel>
              <LocalizedMessage
                id="routesUiPreviewNavigation.disclosureContent"
                values={{ label: label }}
              />
            </Accordion.Panel>
          </Accordion.Item>
        ),
      )}
    </Accordion.Root>
  );
}

export function CollapsibleDemo() {
  return (
    <Collapsible.Root>
      <Collapsible.Trigger render={<Button />}>
        {t("routesUiPreviewNavigation.toggleAdditionalDetails")}
      </Collapsible.Trigger>
      <Collapsible.Panel>
        {t("routesUiPreviewNavigation.additionalAccountDetails")}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

export function TabsDemo() {
  return (
    <Tabs.Root defaultValue="profile">
      <Tabs.List aria-label={t("routesUiPreviewNavigation.accountSections")}>
        <Tabs.Tab value="profile">{t("routesUiPreviewNavigation.profile")}</Tabs.Tab>
        <Tabs.Tab value="security">{t("routesUiPreviewNavigation.security")}</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="profile">{t("routesUiPreviewNavigation.profilePanel")}</Tabs.Panel>
      <Tabs.Panel value="security">{t("routesUiPreviewNavigation.securityPanel")}</Tabs.Panel>
    </Tabs.Root>
  );
}

export function MenubarDemo() {
  const [result, setResult] = useState("");
  return (
    <>
      <Menubar aria-label={t("routesUiPreviewNavigation.exampleApplicationMenu")}>
        {[t("routesUiPreviewNavigation.file"), t("common.edit")].map((name) => (
          <Menu.Root key={name}>
            <Menu.Trigger>{name}</Menu.Trigger>
            <MenuPopup>
              <Menu.Item
                onClick={() =>
                  setResult(t("routesUiPreviewNavigation.actionSelected", { name: name }))
                }
              >
                <LocalizedMessage id="routesUiPreviewNavigation.action" values={{ name: name }} />
              </Menu.Item>
              <Menu.Item disabled>{t("routesUiPreviewNavigation.unavailableAction")}</Menu.Item>
            </MenuPopup>
          </Menu.Root>
        ))}
      </Menubar>
      <p role="status">{result}</p>
    </>
  );
}

export function NavigationMenuDemo() {
  return (
    <>
      <NavigationMenu.Root aria-label={t("routesUiPreviewNavigation.exampleNavigation")}>
        <NavigationMenu.List>
          <NavigationMenu.Item>
            <NavigationMenu.Trigger>
              {t("routesUiPreviewNavigation.components")}
            </NavigationMenu.Trigger>
            <NavigationMenu.Content>
              <NavigationMenu.Link href="#preview-nav-directory">
                {t("routesUiPreviewNavigation.directoryExample")}
              </NavigationMenu.Link>{" "}
              <NavigationMenu.Link href="#preview-nav-settings">
                {t("routesUiPreviewNavigation.settingsExample")}
              </NavigationMenu.Link>
            </NavigationMenu.Content>
          </NavigationMenu.Item>
          <NavigationMenu.Item>
            <NavigationMenu.Link href="#preview-nav-directory">
              {t("routesUiPreviewNavigation.directoryHome")}
            </NavigationMenu.Link>
          </NavigationMenu.Item>
        </NavigationMenu.List>
        <NavigationMenuPopup>
          <NavigationMenu.Viewport />
        </NavigationMenuPopup>
      </NavigationMenu.Root>
      <p id="preview-nav-directory">{t("routesUiPreviewNavigation.exampleDirectoryDestination")}</p>
      <p id="preview-nav-settings">{t("routesUiPreviewNavigation.exampleSettingsDestination")}</p>
    </>
  );
}

export function ToolbarDemo() {
  const [result, setResult] = useState("");
  return (
    <>
      <Toolbar.Root aria-label={t("routesUiPreviewNavigation.exampleEditorToolbar")}>
        <Toolbar.Group aria-label={t("routesUiPreviewNavigation.editingActions")}>
          <Toolbar.Button onClick={() => setResult(t("routesUiPreviewNavigation.undoSelected"))}>
            {t("routesUiPreviewNavigation.undo")}
          </Toolbar.Button>
          <Toolbar.Button onClick={() => setResult(t("routesUiPreviewNavigation.redoSelected"))}>
            {t("routesUiPreviewNavigation.redo")}
          </Toolbar.Button>
        </Toolbar.Group>
        <Toolbar.Separator />
        <Toolbar.Link href="#preview-toolbar-document">
          {t("routesUiPreviewNavigation.goToDocument")}
        </Toolbar.Link>
        <Toolbar.Input
          aria-label={t("routesUiPreviewNavigation.findInDocument")}
          placeholder={t("routesUiPreviewNavigation.findInDocument")}
        />
      </Toolbar.Root>
      <p role="status">{result}</p>
      <p id="preview-toolbar-document">{t("routesUiPreviewNavigation.exampleDocument")}</p>
    </>
  );
}
