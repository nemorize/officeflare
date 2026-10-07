import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Navigate, Route, Routes } from "react-router";
import { LoginPage } from "./routes/login";
import { UIProvider } from "@/components/ui";
import "./styles.css";

const UIPreviewPage = import.meta.env.DEV ? lazy(() => import("./routes/ui-preview")) : null;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <UIProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Navigate to="/login" replace />} />
          <Route path="/login" element={<LoginPage />} />
          {UIPreviewPage && <Route path="/dev/ui" element={
            <Suspense fallback={<p>Loading components…</p>}><UIPreviewPage /></Suspense>
          } />}
          <Route path="*" element={
            <main className="empty-page">
              <h1>Page not found</h1>
              <p>Check the address or return to the sign-in page.</p>
              <Link to="/login">Go to sign in</Link>
            </main>
          } />
        </Routes>
      </BrowserRouter>
    </UIProvider>
  </StrictMode>,
);
