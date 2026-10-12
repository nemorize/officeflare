import { lazy, StrictMode, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createBrowserRouter, createRoutesFromElements, RouterProvider, Link, Navigate, Route } from "react-router";
import { LoginPage } from "./routes/login";
import { UIProvider } from "@/components/ui";
import { EmptyWorkspacePage, WorkspaceLayout } from "./routes/workspace";
import { workspaceApps } from "./lib/workspace-navigation";
import { ConsoleGate, ConsoleHome, ServiceGate, WorkspaceHome } from "./components/console-access";
import { userPermissions, rolePermissions, driveAdminPermissions } from "./lib/console";
import "./styles.css";

const UIPreviewPage = import.meta.env.DEV ? lazy(() => import("./routes/ui-preview")) : null;
const ProfilePage = lazy(() => import("./routes/profile").then((module) => ({ default: module.ProfilePage })));
const SecurityPage = lazy(() => import("./routes/security").then((module) => ({ default: module.SecurityPage })));
const SessionsPage = lazy(() => import("./routes/sessions").then((module) => ({ default: module.SessionsPage })));
const NotificationsPage = lazy(() => import("./routes/notifications").then((module) => ({ default: module.NotificationsPage })));
const NotificationSettingsPage = lazy(() => import("./routes/notifications").then((module) => ({ default: module.NotificationSettingsPage })));
const UsersPage = lazy(() => import("./routes/console-users").then((module) => ({ default: module.UsersPage })));
const UserEditorPage = lazy(() => import("./routes/console-users").then((module) => ({ default: module.UserEditorPage })));
const RolesPage = lazy(() => import("./routes/console-roles").then((module) => ({ default: module.RolesPage })));
const RoleEditorPage = lazy(() => import("./routes/console-roles").then((module) => ({ default: module.RoleEditorPage })));
const DriveConsoleLayout = lazy(() => import("./routes/console-drive").then(module => ({ default: module.DriveConsoleLayout })));
const DriveConsolePage = lazy(() => import("./routes/console-drive").then(module => ({ default: module.DriveConsolePage })));
const DriveAccountEditorPage = lazy(() => import("./routes/console-drive").then(module => ({ default: module.DriveAccountEditorPage })));
const DrivePage = lazy(() => import("./routes/drive").then((module) => ({ default: module.DrivePage })));
const DriveLinkedItemPage = lazy(() => import("./routes/drive").then((module) => ({ default: module.DriveLinkedItemPage })));
const PublicDrivePage = lazy(() => import("./routes/drive-public").then((module) => ({ default: module.PublicDrivePage })));
const MailPage = lazy(() => import("./routes/mail").then((module) => ({ default: module.MailPage })));
const MailManagePage = lazy(() => import("./routes/mail-manage").then((module) => ({ default: module.MailManagePage })));
const MailIntegrationsPage = lazy(() => import("./routes/mail-integrations").then((module) => ({ default: module.MailIntegrationsPage })));
const MailDataPage = lazy(() => import("./routes/mail-data").then((module) => ({ default: module.MailDataPage })));
const MailConsolePage = lazy(() => import("./routes/console-mail").then((module) => ({ default: module.MailConsolePage })));
const SharedMailboxEditorPage = lazy(() => import("./routes/console-shared-mailboxes").then((module) => ({ default: module.SharedMailboxEditorPage })));
const MailDomainEditorPage = lazy(() => import("./routes/console-mail").then((module) => ({ default: module.MailDomainEditorPage })));

const root: Root = import.meta.hot?.data.root ?? createRoot(document.getElementById("root")!);
if (import.meta.hot) import.meta.hot.data.root = root;
const router = createBrowserRouter(createRoutesFromElements(<>

          <Route path="/login" element={<LoginPage />} />
          <Route path="/share/drive/:token" element={<Suspense fallback={<p className="empty-page">Opening shared files…</p>}><PublicDrivePage /></Suspense>} />
          <Route element={<WorkspaceLayout />}>
            <Route path="/" element={<WorkspaceHome />} />
            {workspaceApps.filter((app) => app.path !== "/mail" && app.path !== "/drive").flatMap((app) => app.menu.map((item) =>
              <Route key={item.path} path={item.path} element={<ServiceGate permission={app.permission}><EmptyWorkspacePage title={item.name} /></ServiceGate>} />
            ))}
            <Route path="/drive/items/:itemId" element={<ServiceGate permission="drive.access"><DriveLinkedItemPage /></ServiceGate>} />
            {["/drive", "/drive/shared", "/drive/recent", "/drive/starred", "/drive/trash", "/drive/folders/:folderId"].map((path) => <Route key={path} path={path} element={<ServiceGate permission="drive.access"><DrivePage /></ServiceGate>} />)}
            {["/mail", "/mail/starred", "/mail/snoozed", "/mail/all", "/mail/scheduled", "/mail/drafts", "/mail/sent", "/mail/archive", "/mail/spam", "/mail/trash", "/mail/folders/:folder"].map((path) => <Route key={path} path={path} element={<ServiceGate permission="mail.access"><MailPage /></ServiceGate>} />)}
            {["rules", "settings"].map((page) => <Route key={page} path={`/mail/${page}`} element={<ServiceGate permission="mail.access"><MailManagePage key={page} page={page} /></ServiceGate>} />)}
            <Route path="/mail/integrations" element={<ServiceGate permission="mail.access"><MailIntegrationsPage /></ServiceGate>} />
            {["data", "activity"].map((page) => <Route key={page} path={`/mail/${page}`} element={<ServiceGate permission="mail.access"><MailDataPage key={page} page={page} /></ServiceGate>} />)}
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="/profile/security" element={<SecurityPage />} />
            <Route path="/profile/sessions" element={<SessionsPage />} />
            <Route path="/notifications" element={<NotificationsPage />} />
            <Route path="/profile/notifications" element={<NotificationSettingsPage />} />
            <Route path="/console" element={<ConsoleGate />}>
              <Route index element={<ConsoleHome />} />
              <Route path="users" element={<ConsoleGate permissions={userPermissions}><UsersPage /></ConsoleGate>} />
              <Route path="users/new" element={<ConsoleGate permissions={["admin.users.create"]}><UserEditorPage key="new" creating /></ConsoleGate>} />
              <Route path="users/:id" element={<ConsoleGate permissions={["admin.users.read"]}><UserEditorPage /></ConsoleGate>} />
              <Route path="roles" element={<ConsoleGate permissions={rolePermissions}><RolesPage /></ConsoleGate>} />
              <Route path="roles/new" element={<ConsoleGate permissions={["admin.roles.create"]}><RoleEditorPage key="new" creating /></ConsoleGate>} />
              <Route path="roles/:id" element={<ConsoleGate permissions={["admin.roles.read"]}><RoleEditorPage /></ConsoleGate>} />
              <Route path="drive" element={<ConsoleGate permissions={driveAdminPermissions}><DriveConsoleLayout /></ConsoleGate>}>
                <Route index element={<DriveConsolePage page="home" />} />
                {["overview", "accounts", "items", "sharing", "settings", "activity"].map(page => <Route key={page} path={page} element={<DriveConsolePage key={page} page={page} />} />)}
                <Route path="accounts/:id" element={<ConsoleGate permissions={["admin.drive.accounts.read"]}><DriveAccountEditorPage /></ConsoleGate>} />
              </Route>
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

</>));
if (import.meta.hot) import.meta.hot.dispose(() => router.dispose());
root.render(<StrictMode><UIProvider><RouterProvider router={router} /></UIProvider></StrictMode>);
