// The waiting page's look. Display only: nothing here changes how the front
// door wakes, polls or redirects.
//
// PAGE_THEME (template parameter PageTheme) picks one:
//   ""        the original brickskate look. It is the default, so the demo
//             door and any stack that doesn't set PageTheme are unchanged.
//   "zamboni" the Zamboni planner's colours, fonts and browser-bar colour,
//             light and dark, so a visitor waking it sees the same look
//             before and after the app opens. The values are copied from
//             Zamboni's own token file (src/planner/theme.py in
//             janhaak/intentional-planner); change them there first.
// An unknown name falls back to the default.

const DEFAULT_STYLE = `
  :root { color-scheme: light dark; }
  * { margin: 0; box-sizing: border-box; }
  body {
    font-family: ui-rounded, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    min-height: 100dvh; display: flex; align-items: center; justify-content: center;
    background: #f4f2ec; color: #2c2a26; padding: 24px;
  }
  .card { text-align: center; max-width: 26rem; }
  h1 { font-size: 1.5rem; font-weight: 650; margin: 20px 0 8px; }
  p { color: #6b675e; line-height: 1.5; }
  .spinner {
    width: 56px; height: 56px; margin: 0 auto;
    border: 4px solid rgba(125, 115, 95, .2); border-top-color: #7a6f5a;
    border-radius: 50%; animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .elapsed { margin-top: 16px; font-variant-numeric: tabular-nums; font-size: .85rem; color: #a09a8d; }
  .err { color: #a4472e; }
  a { color: #7a6f5a; }
  @media (prefers-color-scheme: dark) {
    body { background: #191817; color: #e8e5df; }
    p { color: #a39e93; }
    .spinner { border-color: rgba(200, 190, 170, .15); border-top-color: #c8bda3; }
    .err { color: #e08563; }
    a { color: #c8bda3; }
  }
`;

// Zamboni's tokens, light and dark (theme.py COLOURS / FAMILIES / SIZES).
const Z = {
  light: {
    rink: "#e9eff6", ice: "#f6f9fc", boards: "#d5dee9",
    puck: "#0e1a2b", puck2: "#3b4a5f", puck3: "#536175",
    blue: "#0a5bb5", red: "#b92626",
  },
  dark: {
    rink: "#090e14", ice: "#0e141b", boards: "#222c3a",
    puck: "#e6ecf3", puck2: "#a8b4c3", puck3: "#7d8ba0",
    blue: "#7cc4ff", red: "#ff7a7a",
  },
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
};

const vars = (m) =>
  `--rink: ${m.rink}; --boards: ${m.boards}; --puck: ${m.puck}; --puck-2: ${m.puck2}; ` +
  `--puck-3: ${m.puck3}; --blue: ${m.blue}; --red: ${m.red};`;

const ZAMBONI_STYLE = `
  :root { color-scheme: light dark; ${vars(Z.light)} }
  @media (prefers-color-scheme: dark) {
    :root { color-scheme: dark; ${vars(Z.dark)} }
  }
  html { background: var(--rink); }
  * { margin: 0; box-sizing: border-box; }
  body {
    font-family: ${Z.sans};
    min-height: 100dvh; display: flex; align-items: center; justify-content: center;
    background: var(--rink); color: var(--puck); padding: 24px 16px;
  }
  .card { text-align: center; max-width: 26rem; }
  h1 { font-size: 22px; font-weight: 600; margin: 20px 0 8px; }
  p { font-size: 15px; color: var(--puck-2); line-height: 1.5; }
  .spinner {
    width: 56px; height: 56px; margin: 0 auto;
    border: 4px solid var(--boards); border-top-color: var(--blue);
    border-radius: 50%; animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .elapsed {
    margin-top: 16px; font-family: ${Z.mono}; font-variant-numeric: tabular-nums;
    font-size: 13px; font-weight: 500; color: var(--puck-3);
  }
  .err { color: var(--red); }
  a { color: var(--blue); }
`;

// Read before any CSS: the empty canvas and the phone's status/address bar.
// Zamboni sets the same three tags (theme-color = its header, --ice).
const ZAMBONI_META =
  `<meta name="color-scheme" content="light dark">\n` +
  `<meta name="theme-color" media="(prefers-color-scheme: light)" content="${Z.light.ice}">\n` +
  `<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${Z.dark.ice}">\n`;

const THEMES = {
  default: { style: DEFAULT_STYLE, meta: "" },
  zamboni: { style: ZAMBONI_STYLE, meta: ZAMBONI_META },
};

export function pageTheme(name) {
  return THEMES[String(name ?? "").trim().toLowerCase()] ?? THEMES.default;
}
