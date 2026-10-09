import { lazy, StrictMode, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter, Link, Navigate, Route, Routes } from "react-router";
import { LoginPage } from "./routes/login";
import { UIProvider } from "@/components/ui";
import { EmptyWorkspacePage, WorkspaceLayout } from "./routes/workspace";
import { workspaceApps } from "./lib/workspace-navigation";
import { ConsoleGate, ConsoleHome, ServiceGate, WorkspaceHome } from "./components/console-access";
import { userPermissions, rolePermissions } from "./lib/console";
import "./styles.css";

const UIPreviewPage = import.meta.env.DEV ? lazy(() => import("./routes/ui-preview")) : null;
const ProfilePage = lazy(() => import("./routes/profile").then((module) => ({ default: module.ProfilePage })));
const SecurityPage = lazy(() => import("./routes/security").then((module) => ({ default: module.SecurityPage })));
const SessionsPage = lazy(() => import("./routes/sessions").then((module) => ({ default: module.SessionsPage })));
const UsersPage = lazy(() => import("./routes/console-users").then((module) => ({ default: module.UsersPage })));
const UserEditorPage = lazy(() => import("./routes/console-users").then((module) => ({ default: module.UserEditorPage })));
const RolesPage = lazy(() => import("./routes/console-roles").then((module) => ({ default: module.RolesPage })));
const RoleEditorPage = lazy(() => import("./routes/console-roles").then((module) => ({ default: module.RoleEditorPage })));
const MailPage = lazy(() => import("./routes/mail").then((module) => ({ default: module.MailPage })));
const MailManagePage = lazy(() => import("./routes/mail-manage").then((module) => ({ default: module.MailManagePage })));
const MailIntegrationsPage = lazy(() => import("./routes/mail-integrations").then((module) => ({ default: module.MailIntegrationsPage })));
const MailDataPage = lazy(() => import("./routes/mail-data").then((module) => ({ default: module.MailDataPage })));
const MailConsolePage = lazy(() => import("./routes/console-mail").then((module) => ({ default: module.MailConsolePage })));
const SharedMailboxEditorPage = lazy(() => import("./routes/console-shared-mailboxes").then((module) => ({ default: module.SharedMailboxEditorPage })));
const MailDomainEditorPage = lazy(() => import("./routes/console-mail").then((module) => ({ default: module.MailDomainEditorPage })));

const root: Root = import.meta.hot?.data.root ?? createRoot(document.getElementById("root")!);
if (import.meta.hot) import.meta.hot.data.root = root;
root.render(
  <StrictMode>
    <UIProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<WorkspaceLayout />}>
            <Route path="/" element={<WorkspaceHome />} />
            {workspaceApps.filter((app) => app.path !== "/mail").flatMap((app) => app.menu.map((item) =>
              <Route key={item.path} path={item.path} element={<ServiceGate permission={app.permission}><EmptyWorkspacePage title={item.name} /></ServiceGate>} />
            ))}
            {["/mail", "/mail/starred", "/mail/snoozed", "/mail/drafts", "/mail/sent", "/mail/archive", "/mail/spam", "/mail/trash", "/mail/folders/:folder"].map((path) => <Route key={path} path={path} element={<ServiceGate permission="mail.access"><MailPage /></ServiceGate>} />)}
            {["templates", "rules", "settings"].map((page) => <Route key={page} path={`/mail/${page}`} element={<ServiceGate permission="mail.access"><MailManagePage key={page} page={page} /></ServiceGate>} />)}
            <Route path="/mail/integrations" element={<ServiceGate permission="mail.access"><MailIntegrationsPage /></ServiceGate>} />
            {["data", "activity"].map((page) => <Route key={page} path={`/mail/${page}`} element={<ServiceGate permission="mail.access"><MailDataPage key={page} page={page} /></ServiceGate>} />)}
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="/profile/security" element={<SecurityPage />} />
            <Route path="/profile/sessions" element={<SessionsPage />} />
            <Route path="/console" element={<ConsoleGate />}>
              <Route index element={<ConsoleHome />} />
              <Route path="users" element={<ConsoleGate permissions={userPermissions}><UsersPage /></ConsoleGate>} />
              <Route path="users/new" element={<ConsoleGate permissions={["admin.users.create"]}><UserEditorPage key="new" creating /></ConsoleGate>} />
              <Route path="users/:id" element={<ConsoleGate permissions={["admin.users.read"]}><UserEditorPage /></ConsoleGate>} />
              <Route path="roles" element={<ConsoleGate permissions={rolePermissions}><RolesPage /></ConsoleGate>} />
              <Route path="roles/new" element={<ConsoleGate permissions={["admin.roles.create"]}><RoleEditorPage key="new" creating /></ConsoleGate>} />
              <Route path="roles/:id" element={<ConsoleGate permissions={["admin.roles.read"]}><RoleEditorPage /></ConsoleGate>} />
              {["domains", "mailboxes"].map((page) => <Route key={page} path={`mail/${page}`} element={<ConsoleGate permissions={[`admin.mail.${page}.read`]}><MailConsolePage key={page} page={page} /></ConsoleGate>} />)}
              <Route path="mail/domains/new" element={<ConsoleGate permissions={["admin.mail.domains.manage"]}><MailDomainEditorPage key="new" creating /></ConsoleGate>} />
              <Route path="mail/domains/:id" element={<ConsoleGate permissions={["admin.mail.domains.read"]}><MailDomainEditorPage /></ConsoleGate>} />
              <Route path="mail/mailboxes/new" element={<ConsoleGate permissions={["admin.mail.mailboxes.manage"]}><SharedMailboxEditorPage key="new" creating /></ConsoleGate>} />
              <Route path="mail/mailboxes/:id" element={<ConsoleGate permissions={["admin.mail.mailboxes.read"]}><SharedMailboxEditorPage /></ConsoleGate>} />
              <Route path="mail/providers" element={<Navigate to="/console/mail/domains" replace />} />
            </Route>
            <Route path="*" element={
              <section className="account-page">
                <header className="account-page-header"><h1>Page not found</h1><p>Check the address or return to your workspace.</p></header>
                <Link to="/">Return to workspace</Link>
              </section>
            } />
          </Route>
          {UIPreviewPage && <Route path="/dev/ui" element={
            <Suspense fallback={<p>Loading components…</p>}><UIPreviewPage /></Suspense>
          } />}
        </Routes>
      </BrowserRouter>
    </UIProvider>
  </StrictMode>,
);
