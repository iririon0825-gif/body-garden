// Body Garden — 線アイコン（インラインSVG）
// 丸角タイル画像に代わる、下部Navigation／カード見出し用の繊細な線画アイコン。
// currentColorで着色するため、色はCSS側（.nav-icon-svg / .title-icon-svg）で指定する。
// Goal達成エンブレム・maintenance・LOWER LINEの丸角タイル画像はこの対象外（維持する）。

const Icons = {
  _defs: {
    home: `<path d="M4 11.5 12 4l8 7.5" /><path d="M6 10v9a1 1 0 0 0 1 1h3v-6h4v6h3a1 1 0 0 0 1-1v-9" />`,

    records: `<path d="M5 19V10" /><path d="M12 19V5" /><path d="M19 19v-6" /><path d="M3 19h18" />`,

    injection: `<g transform="rotate(45 12 12)">
      <rect x="9" y="2.5" width="6" height="4" rx="0.6" />
      <line x1="12" y1="6.5" x2="12" y2="9" />
      <rect x="8.5" y="9" width="7" height="8" rx="1.2" />
      <line x1="6.3" y1="10.5" x2="8.5" y2="10.5" />
      <line x1="6.3" y1="13" x2="8.5" y2="13" />
      <line x1="12" y1="17" x2="12" y2="19" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </g>`,

    composition: `<circle cx="12" cy="12" r="8" /><path d="M12 12V4" /><path d="M12 12l6.2 4.1" />`,

    settings: `<line x1="4" y1="7" x2="20" y2="7" /><circle cx="9" cy="7" r="2" />
      <line x1="4" y1="12" x2="20" y2="12" /><circle cx="16" cy="12" r="2" />
      <line x1="4" y1="17" x2="20" y2="17" /><circle cx="11" cy="17" r="2" />`,

    weight: `<rect x="4" y="9" width="16" height="11" rx="2.5" /><circle cx="12" cy="14.5" r="2.6" />
      <path d="M9 9c0-2 1.4-4 3-4s3 2 3 4" />`,

    goal: `<line x1="6" y1="3" x2="6" y2="21" /><path d="M6 4h11l-3 3.5L17 11H6" />`,

    trend: `<path d="M4 4v14a1 1 0 0 0 1 1h15" /><path d="M6.5 13l3.5-3 3 2 5-5" />
      <circle cx="6.5" cy="13" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="18" cy="7" r="0.9" fill="currentColor" stroke="none" />`,

    protein: `<path d="M7.5 3v5M9.5 3v5M11.5 3v5" />
      <path d="M7.5 8c0 1.2 0.9 2.2 2 2.2s2-1 2-2.2" />
      <path d="M9.5 10.2V21" />
      <path d="M16 3c-1.7 0-3 2.2-3 5s1.3 5 3 5" />
      <path d="M16 13v8" />`,

    condition: `<path d="M12 20.2s-7.2-4.4-9.6-8.7C1 8 2 4.3 5.6 3.8c2-.3 3.8.8 4.7 2.1.8-1.3 2.6-2.4 4.6-2.1 3.6.5 4.6 4.2 3.1 7.7C19.2 15.8 12 20.2 12 20.2z" />`,
  },

  svg(name, className) {
    const inner = this._defs[name] || "";
    const cls = className ? ` class="${className}"` : "";
    return `<svg${cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  },
};
