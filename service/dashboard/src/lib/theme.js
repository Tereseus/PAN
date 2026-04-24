export const THEMES = {
  'cool-guy': {
    '--pan-bg':         '#0a0a0f',
    '--pan-surface':    '#12121a',
    '--pan-surface2':   '#1a1a25',
    '--pan-base':       '#1e1e2e',
    '--pan-overlay':    '#313244',
    '--pan-muted':      '#45475a',
    '--pan-dim':        '#585b70',
    '--pan-faint':      '#6c7086',
    '--pan-sub':        '#a6adc8',
    '--pan-text':       '#cdd6f4',
    '--pan-accent':     '#89b4fa',
    '--pan-accent2':    '#a6e3a1',
    '--pan-red':        '#f38ba8',
    '--pan-yellow':     '#f9e2af',
    '--pan-orange':     '#fab387',
    '--pan-glow':       'rgba(137,180,250,0.18)',
    '--pan-logo-color': '#89b4fa',
    '--pan-logo-shadow':'0 0 18px rgba(137,180,250,0.5)',
  },
  'blinding-light': {
    '--pan-bg':         '#ffffff',
    '--pan-surface':    '#f5f5f5',
    '--pan-surface2':   '#eeeeee',
    '--pan-base':       '#e0e0e0',
    '--pan-overlay':    '#d0d0d0',
    '--pan-muted':      '#bdbdbd',
    '--pan-dim':        '#9e9e9e',
    '--pan-faint':      '#757575',
    '--pan-sub':        '#424242',
    '--pan-text':       '#111111',
    '--pan-accent':     '#1565c0',
    '--pan-accent2':    '#2e7d32',
    '--pan-red':        '#c62828',
    '--pan-yellow':     '#f57f17',
    '--pan-orange':     '#e64a19',
    '--pan-glow':       'rgba(21,101,192,0.15)',
    '--pan-logo-color': '#1565c0',
    '--pan-logo-shadow':'0 0 12px rgba(21,101,192,0.3)',
  },
  'silver-platter': {
    '--pan-bg':         '#d8d8e4',
    '--pan-surface':    '#c8c8d8',
    '--pan-surface2':   '#b8b8cc',
    '--pan-base':       '#a8a8bc',
    '--pan-overlay':    '#9898ac',
    '--pan-muted':      '#7878a0',
    '--pan-dim':        '#585890',
    '--pan-faint':      '#484878',
    '--pan-sub':        '#303060',
    '--pan-text':       '#1a1a2e',
    '--pan-accent':     '#5c6bc0',
    '--pan-accent2':    '#2e7d32',
    '--pan-red':        '#c62828',
    '--pan-yellow':     '#f9a825',
    '--pan-orange':     '#d84315',
    '--pan-glow':       'rgba(92,107,192,0.2)',
    '--pan-logo-color': '#5c6bc0',
    '--pan-logo-shadow':'2px 2px 0 rgba(0,0,0,0.15), 0 0 12px rgba(92,107,192,0.3)',
  },
  'vibe': {
    '--pan-bg':         '#0d0621',
    '--pan-surface':    '#1a0a2e',
    '--pan-surface2':   '#2d1040',
    '--pan-base':       '#4a1060',
    '--pan-overlay':    '#6b2080',
    '--pan-muted':      '#8a3898',
    '--pan-dim':        '#c060c0',
    '--pan-faint':      '#e080d0',
    '--pan-sub':        '#f0a8e0',
    '--pan-text':       '#ffe4f5',
    '--pan-accent':     '#ff1493',
    '--pan-accent2':    '#00e5ff',
    '--pan-red':        '#ff6b6b',
    '--pan-yellow':     '#ffb347',
    '--pan-orange':     '#ff6b35',
    '--pan-glow':       'rgba(255,20,147,0.25)',
    '--pan-logo-color': '#ff1493',
    '--pan-logo-shadow':'0 0 20px rgba(255,20,147,0.7), 0 0 40px rgba(0,229,255,0.3)',
  },
};

export const THEME_META = {
  'cool-guy':       { label: 'Cool Guy',       emoji: '😎' },
  'blinding-light': { label: 'Blinding Light', emoji: '☀️' },
  'silver-platter': { label: 'Silver Platter', emoji: '🪙' },
  'vibe':           { label: "It's a Vibe",    emoji: '🌴' },
};

export function applyTheme(name) {
  const theme = THEMES[name] || THEMES['cool-guy'];
  let el = document.getElementById('pan-theme-vars');
  if (!el) {
    el = document.createElement('style');
    el.id = 'pan-theme-vars';
    document.head.appendChild(el);
  }
  const vars = Object.entries(theme).map(([k, v]) => `  ${k}: ${v};`).join('\n');
  el.textContent = `:root {\n${vars}\n}`;
  document.documentElement.dataset.theme = name;
  try { localStorage.setItem('pan-theme', name); } catch {}
}

export function loadTheme() {
  const saved = (() => { try { return localStorage.getItem('pan-theme'); } catch { return null; } })();
  applyTheme(saved || 'cool-guy');
  return saved || 'cool-guy';
}

// Legacy export kept for backward compat
export const dark = {
  bg: '#0a0a0f',
  surface: '#12121a',
  surfaceHover: '#1a1a25',
  border: '#1e1e2e',
  text: '#cdd6f4',
  textMuted: '#6c7086',
  accent: '#89b4fa',
  accent2: '#a6e3a1',
  accent3: '#f9e2af',
  danger: '#f38ba8',
  glow: 'rgba(137, 180, 250, 0.15)',
};
