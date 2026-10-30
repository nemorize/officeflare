import { LocalizedMessage } from "../components/i18n";
import { t } from "../../shared/i18n/index.ts";
import { useEffect, useState, type ComponentType } from "react";
import { Link } from "react-router";
import {
  Button,
  Icon,
  OfficeflareMark,
  Select,
  SelectPopup,
  SearchField,
  Input,
} from "@/components/ui";
import * as Forms from "./ui-preview/forms";
import * as Popups from "./ui-preview/popups";
import * as Navigation from "./ui-preview/navigation";
import * as Display from "./ui-preview/display";
import "./ui-preview/styles.css";

interface Example {
  name: string;
  slug: string;
  component: ComponentType;
}

const groups: { name: string; examples: Example[] }[] = [
  {
    name: t("routesUiPreview.formControls"),
    examples: [
      {
        name: t("routesUiPreview.autocomplete"),
        slug: "autocomplete",
        component: Forms.AutocompleteDemo,
      },
      { name: t("routesUiPreview.checkbox"), slug: "checkbox", component: Forms.CheckboxDemo },
      {
        name: t("routesUiPreview.checkboxGroup"),
        slug: "checkbox-group",
        component: Forms.CheckboxGroupDemo,
      },
      { name: t("routesUiPreview.combobox"), slug: "combobox", component: Forms.ComboboxDemo },
      { name: t("routesUiPreview.field"), slug: "field", component: Forms.FieldDemo },
      { name: t("routesUiPreview.fieldset"), slug: "fieldset", component: Forms.FieldsetDemo },
      { name: t("routesUiPreview.form"), slug: "form", component: Forms.FormDemo },
      { name: t("routesUiPreview.input"), slug: "input", component: Forms.InputDemo },
      {
        name: t("routesUiPreview.numberField"),
        slug: "number-field",
        component: Forms.NumberFieldDemo,
      },
      { name: t("routesUiPreview.otpField"), slug: "otp-field", component: Forms.OTPFieldDemo },
      {
        name: t("routesUiPreview.radioGroup"),
        slug: "radio-group",
        component: Forms.RadioGroupDemo,
      },
      { name: t("routesUiPreview.select"), slug: "select", component: Forms.SelectDemo },
      { name: t("routesUiPreview.slider"), slug: "slider", component: Forms.SliderDemo },
      { name: t("routesUiPreview.switch"), slug: "switch", component: Forms.SwitchDemo },
    ],
  },
  {
    name: t("routesUiPreview.popupsAndNotifications"),
    examples: [
      {
        name: t("routesUiPreview.alertDialog"),
        slug: "alert-dialog",
        component: Popups.AlertDialogDemo,
      },
      {
        name: t("routesUiPreview.contextMenu"),
        slug: "context-menu",
        component: Popups.ContextMenuDemo,
      },
      { name: t("routesUiPreview.dialog"), slug: "dialog", component: Popups.DialogDemo },
      { name: t("routesUiPreview.drawer"), slug: "drawer", component: Popups.DrawerDemo },
      { name: t("routesUiPreview.menu"), slug: "menu", component: Popups.MenuDemo },
      { name: t("routesUiPreview.popover"), slug: "popover", component: Popups.PopoverDemo },
      {
        name: t("routesUiPreview.previewCard"),
        slug: "preview-card",
        component: Popups.PreviewCardDemo,
      },
      { name: t("routesUiPreview.toast"), slug: "toast", component: Popups.ToastDemo },
      { name: t("routesUiPreview.tooltip"), slug: "tooltip", component: Popups.TooltipDemo },
    ],
  },
  {
    name: t("routesUiPreview.navigationAndDisclosure"),
    examples: [
      {
        name: t("routesUiPreview.accordion"),
        slug: "accordion",
        component: Navigation.AccordionDemo,
      },
      {
        name: t("routesUiPreview.collapsible"),
        slug: "collapsible",
        component: Navigation.CollapsibleDemo,
      },
      { name: t("routesUiPreview.menubar"), slug: "menubar", component: Navigation.MenubarDemo },
      {
        name: t("routesUiPreview.navigationMenu"),
        slug: "navigation-menu",
        component: Navigation.NavigationMenuDemo,
      },
      { name: t("routesUiPreview.tabs"), slug: "tabs", component: Navigation.TabsDemo },
      { name: t("routesUiPreview.toolbar"), slug: "toolbar", component: Navigation.ToolbarDemo },
    ],
  },
  {
    name: t("routesUiPreview.actionsAndDisplay"),
    examples: [
      { name: t("routesUiPreview.avatar"), slug: "avatar", component: Display.AvatarDemo },
      { name: t("routesUiPreview.button"), slug: "button", component: Display.ButtonDemo },
      { name: t("routesUiPreview.meter"), slug: "meter", component: Display.MeterDemo },
      { name: t("routesUiPreview.progress"), slug: "progress", component: Display.ProgressDemo },
      {
        name: t("routesUiPreview.scrollArea"),
        slug: "scroll-area",
        component: Display.ScrollAreaDemo,
      },
      { name: t("routesUiPreview.separator"), slug: "separator", component: Display.SeparatorDemo },
      { name: t("routesUiPreview.toggle"), slug: "toggle", component: Display.ToggleDemo },
      {
        name: t("routesUiPreview.toggleGroup"),
        slug: "toggle-group",
        component: Display.ToggleGroupDemo,
      },
    ],
  },
];

const total = groups.reduce((count, group) => count + group.examples.length, 0);

const groupIcons = ["controls", "layers", "navigation", "circle"] as const;
const categoryItems = [
  { value: "all", label: t("routesUiPreview.allComponents") },
  ...groups.map(({ name }) => ({ value: name, label: name })),
];

function ComponentSearch({
  query,
  onChange,
  mobile = false,
}: {
  query: string;
  onChange: (query: string) => void;
  mobile?: boolean;
}) {
  return (
    <SearchField
      className={`gallery-search ${mobile ? "gallery-search-mobile" : ""}`}
      onSubmit={(event) => event.preventDefault()}
    >
      <Icon name="search" />
      <Input
        variant="integrated"
        aria-label={t("routesUiPreview.searchComponents")}
        name={mobile ? "component-search-mobile" : "component-search"}
        value={query}
        onValueChange={onChange}
        placeholder={t("routesUiPreview.searchComponents")}
      />
      {query && (
        <Button
          size="icon"
          variant="ghost"
          onClick={() => onChange("")}
          aria-label={t("routesUiPreview.clearSearch")}
        >
          <Icon name="close" width="13" height="13" />
        </Button>
      )}
    </SearchField>
  );
}

// Loaded only by the development router; examples never call account APIs.
export default function UIPreviewPage() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [active, setActive] = useState("");
  const search = query.trim().toLowerCase();
  const visibleGroups = groups
    .filter((group) => category === "all" || group.name === category)
    .map((group) => ({
      ...group,
      examples: group.examples.filter(({ name, slug }) =>
        `${name} ${slug}`.toLowerCase().includes(search),
      ),
    }))
    .filter((group) => group.examples.length > 0);
  const visibleCount = visibleGroups.reduce((count, group) => count + group.examples.length, 0);

  useEffect(() => {
    document.title = t("routesUiPreview.uiComponentsOfficeflare");
    document.querySelector(".gallery-workspace")?.scrollTo({ top: 0, behavior: "instant" });
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.find((candidate) => candidate.isIntersecting);
        if (entry) setActive(entry.target.id.replace("demo-", ""));
      },
      {
        root: document.querySelector(".gallery-workspace"),
        rootMargin: t("routesUiPreview.100px0px650px"),
      },
    );
    document.querySelectorAll(".component-example").forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [query, category]);

  return (
    <div className="gallery-shell">
      <aside className="gallery-rail" aria-label={t("routesUiPreview.libraryCategories")}>
        <a
          href="#gallery-main"
          className="gallery-mark"
          aria-label={t("routesUiPreview.officeflareComponentLibrary")}
        >
          <OfficeflareMark />
        </a>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("routesUiPreview.allComponents")}
          aria-pressed={category === "all"}
          onClick={() => setCategory("all")}
        >
          <Icon name="grid" />
        </Button>
        {groups.map((group, index) => (
          <Button
            key={group.name}
            variant="ghost"
            size="icon"
            aria-label={group.name}
            aria-pressed={category === group.name}
            onClick={() => setCategory(group.name)}
          >
            <Icon name={groupIcons[index]!} />
          </Button>
        ))}
        <Link
          to="/login"
          className="gallery-rail-account"
          aria-label={t("routesUiPreview.goToSignIn")}
        >
          <Icon name="user" />
        </Link>
      </aside>
      <div className="gallery-frame">
        <aside className="gallery-sidebar">
          <div className="gallery-sidebar-header">
            <div className="gallery-sidebar-title">
              {t("routesUiPreview.components")}
              <span className="gallery-count">{total}</span>
            </div>
            <ComponentSearch query={query} onChange={setQuery} />
          </div>
          <nav aria-label={t("routesUiPreview.componentExamples")} className="gallery-nav">
            {visibleGroups.map((group) => (
              <div className="gallery-nav-group" key={group.name}>
                <h2>{group.name}</h2>
                {group.examples.map(({ name, slug }) => (
                  <a
                    key={slug}
                    href={`#demo-${slug}`}
                    aria-current={active === slug ? "location" : undefined}
                    onClick={() => setActive(slug)}
                  >
                    {name}
                  </a>
                ))}
              </div>
            ))}
            {visibleCount === 0 && (
              <p className="gallery-sidebar-empty">{t("routesUiPreview.noMatchingComponents")}</p>
            )}
          </nav>
          <div className="gallery-sidebar-footer">
            <Icon name="code" />
            <span>{t("routesUiPreview.officeflareUi")}</span>
          </div>
        </aside>
        <div className="gallery-workspace">
          <header className="gallery-topbar">
            <div className="gallery-breadcrumb">
              <span>{t("common.officeflare")}</span>
              <Icon name="chevron" width="12" height="12" />
              <span>{t("routesUiPreview.componentLibrary")}</span>
            </div>
            <Link to="/login" className="gallery-sign-in">
              {t("routesUiPreview.goToSignIn")}
              <Icon name="arrow" width="14" height="14" />
            </Link>
          </header>
          <main className="gallery-main" id="gallery-main">
            <div className="gallery-intro">
              <h1>{t("routesUiPreview.uiComponents")}</h1>
              <p>{t("routesUiPreview.commonBuildingBlocksForAConsistentWorkspace")}</p>
            </div>
            <div className="gallery-filter-bar">
              <p role="status">
                <LocalizedMessage
                  id="routesUiPreview.showingOfComponents"
                  values={{ visibleCount: visibleCount, total: total }}
                />
              </p>
              <Select.Root
                items={categoryItems}
                value={category}
                onValueChange={(value) => setCategory(value ?? "all")}
              >
                <Select.Label className="visually-hidden">
                  {t("routesUiPreview.componentCategory")}
                </Select.Label>
                <Select.Trigger>
                  <Select.Value />
                </Select.Trigger>
                <SelectPopup>
                  <Select.List>
                    {categoryItems.map(({ value, label }) => (
                      <Select.Item key={value} value={value}>
                        <Select.ItemText>{label}</Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.List>
                </SelectPopup>
              </Select.Root>
            </div>
            <ComponentSearch query={query} onChange={setQuery} mobile />
            {visibleGroups.map((group) => (
              <section className="component-group" key={group.name}>
                <h2>{group.name}</h2>
                <div className="component-panel">
                  {group.examples.map(({ name, slug, component: Demo }) => (
                    <section
                      className="component-example"
                      key={slug}
                      id={`demo-${slug}`}
                      aria-labelledby={`heading-${slug}`}
                    >
                      <div className="component-heading">
                        <h3 id={`heading-${slug}`}>{name}</h3>
                        <a
                          className="component-docs"
                          href={`https://base-ui.com/react/components/${slug}`}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={t("routesUiPreview.documentation", { name: name })}
                          title={t("routesUiPreview.documentation", { name: name })}
                        >
                          <Icon name="external" width="13" height="13" />
                        </a>
                      </div>
                      <div className="component-body">
                        <Demo />
                      </div>
                    </section>
                  ))}
                </div>
              </section>
            ))}
            {visibleCount === 0 && (
              <div className="gallery-empty">
                <Icon name="search" width="24" height="24" />
                <h2>{t("routesUiPreview.noComponentsMatchYourSearch")}</h2>
                <p>{t("routesUiPreview.tryADifferentNameOrResetTheFilters")}</p>
                <Button
                  onClick={() => {
                    setQuery("");
                    setCategory("all");
                  }}
                >
                  {t("routesUiPreview.resetFilters")}
                </Button>
              </div>
            )}
            <footer className="gallery-content-footer">
              {t("routesUiPreview.officeflareComponentLibrary")}
              <span>{t("routesUiPreview.builtWithBaseUi")}</span>
            </footer>
          </main>
        </div>
      </div>
    </div>
  );
}
