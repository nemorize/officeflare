import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Navigate, Route, Routes } from "react-router";
import { LoginPage } from "./routes/login";
import { UIProvider } from "@/components/ui";
import { EmptyWorkspacePage, WorkspaceLayout } from "./routes/workspace";
import { workspaceApps } from "./lib/workspace-navigation";
import "./styles.css";

const UIPreviewPage = import.meta.env.DEV ? lazy(() => import("./routes/ui-preview")) : null;
const ProfilePage = lazy(() => import("./routes/profile").then((module) => ({ default: module.ProfilePage })));
const SecurityPage = lazy(() => import("./routes/security").then((module) => ({ default: module.SecurityPage })));
const SessionsPage = lazy(() => import("./routes/sessions").then((module) => ({ default: module.SessionsPage })));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <UIProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<WorkspaceLayout />}>
            <Route path="/" element={<Navigate to="/mail" replace />} />
            {workspaceApps.flatMap((app) => app.menu.map((item) =>
              <Route key={item.path} path={item.path} element={<EmptyWorkspacePage title={item.name} />} />
            ))}
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="/profile/security" element={<SecurityPage />} />
            <Route path="/profile/sessions" element={<SessionsPage />} />
            <Route path="*" element={
              <section className="account-page">
                <header className="account-page-header"><h1>Page not found</h1><p>Check the address or return to your workspace.</p></header>
                <Link to="/mail">Go to mail</Link>
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
