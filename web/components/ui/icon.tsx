import type { SVGProps } from "react";

const paths = {
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
