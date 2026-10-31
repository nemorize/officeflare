import { createRoot, type Root } from "react-dom/client";

export const root: Root =
  import.meta.hot?.data.root ?? createRoot(document.getElementById("root")!);
if (import.meta.hot) import.meta.hot.data.root = root;
