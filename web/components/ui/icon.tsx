import type { SVGProps } from "react";

const paths = {
  menu: "M4 6h16 M4 12h16 M4 18h16",
  refresh: "M20 8a8 8 0 1 0 0 8 M20 3v5h-5",
  back: "M19 12H5 m6-6-6 6 6 6",
  reply: "m9 5-6 6 6 6 M3 11h10a8 8 0 0 1 8 8",
  replyAll: "m7 5-5 6 5 6 m5-12-5 6 5 6 M7 11h7a7 7 0 0 1 7 7",
  forward: "m15 5 6 6-6 6 M21 11h-10a8 8 0 0 0-8 8",
  clock: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 7v5l3 2",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9 M10 21h4",
  more: "M5 12h.01 M12 12h.01 M19 12h.01",
  attachment: "m8 16 8-8a3 3 0 0 1 4 4L10 22a5 5 0 0 1-7-7L14 4a2 2 0 0 1 3 3L6 18",
  expand: "M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5",
  minimize: "M5 12h14",
  sidebar: "M3 4h18v16H3z M9 4v16",

  search: "m21 21-4.5-4.5 M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  controls: "M4 7h16 M4 17h16 M8 4v6 M16 14v6",
  layers: "m12 3 9 5-9 5-9-5 9-5 M3 12l9 5 9-5 M3 16l9 5 9-5",
  navigation: "m4 4 16 6-7 3-3 7-6-16Z",
  circle: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  chevron: "m8 5 7 7-7 7",
  down: "m6 9 6 6 6-6",
  external: "M14 3h7v7 M21 3l-9 9 M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5",
  arrow: "M5 12h14 m-6-6 6 6-6 6",
  close: "m6 6 12 12 M6 18 18 6",
  check: "m5 12 4 4L19 6",
  plus: "M12 5v14 M5 12h14",
  user: "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M4 21v-2a8 8 0 0 1 16 0v2",
  settings: "M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8 M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3Z",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  eyeOff: "m3 3 18 18 M10 5a12 12 0 0 1 12 7s-1 2-3 4 M14 19C7 21 2 12 2 12s1-2 4-5 M10 10a3 3 0 0 0 4 4",
  info: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 11v6 M12 7h.01",
  shield: "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z m-3 9 2 2 4-4",
  code: "m8 7-5 5 5 5 M16 7l5 5-5 5 m-3-13-2 16",
  console: "M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z m3 5 3 3-3 3 M13 15h4",
  mail: "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z m-1 1 9 7 9-7",
  calendar: "M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z M16 3v4 M8 3v4 M3 11h18 M8 15h2 M14 15h2",
  drive: "m9 3 6 0 7 12-3 5H5l-3-5L9 3Z M9 3l7 12 M2 15h20 M5 20l7-12",
  logout: "M9 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4 M10 12h11 m-4-4 4 4-4 4",
  laptop: "M5 4h14a1 1 0 0 1 1 1v11H4V5a1 1 0 0 1 1-1Z M2 16h20l-1 4H3l-1-4Z",
  inbox: "M5 4h14l3 10v6H2v-6L5 4Z M2 14h6l2 3h4l2-3h6",
  file: "M14 3H5v18h14V8l-5-5Z M14 3v5h5 M8 12h8 M8 16h6",
  archive: "M3 3h18v5H3z M5 8v13h14V8 M9 12h6",
  trash: "M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7",
  folder: "M3 7V4h6l3 3h9v13H3V7Z",
  star: "m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z",
  users: "M15 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M5 21v-2a7 7 0 0 1 14 0v2 M19 4a3 3 0 0 1 0 6 M20 13a5 5 0 0 1 3 5v3",
} as const;

export interface IconProps extends SVGProps<SVGSVGElement> { name: keyof typeof paths; }

export function Icon({ name, ...props }: IconProps) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <path d={paths[name]} />
  </svg>;
}

export function OfficeflareMark(props: SVGProps<SVGSVGElement>) {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
    <rect x="3" y="3" width="18" height="18" rx="5" stroke="currentColor" strokeWidth="1.5" />
    <path d="m13 5-6 9h5l-1 5 6-9h-5l1-5Z" fill="currentColor" />
  </svg>;
}
