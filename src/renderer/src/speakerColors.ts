export const SPEAKER_COLORS = [
  "#38bdf8",
  "#a78bfa",
  "#f472b6",
  "#60a5fa",
  "#2dd4bf",
  "#c084fc",
];

// the two channel identities - must match --me / --them in styles.css
// (canvas + inline SVG can't read CSS custom properties cheaply)
export const CHANNEL_COLORS = { me: "#f5a524", them: "#38bdf8" } as const;
