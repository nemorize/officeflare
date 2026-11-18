export type DriveViewerInput = {
  kind: "drive-viewer:open";
  file: File;
  format: string;
  locale: string;
  theme: "light" | "dark";
  noSearchMatches: string;
};

export type DriveViewerEvent =
  | { kind: "drive-viewer:ready" | "drive-viewer:loaded" | "drive-viewer:close" }
  | { kind: "drive-viewer:error"; encrypted: boolean };
