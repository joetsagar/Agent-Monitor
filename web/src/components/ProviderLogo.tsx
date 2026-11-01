// Match the small canvas marks in Usage-Widget/usage_widget.pyw.
export function ProviderLogo({ id }: { id: "claude" | "codex" | "kilo" | "unknown" }) {
  return <svg className={`usage-provider-logo logo-${id}`} data-provider={id} viewBox="0 0 18 18" aria-hidden="true" focusable="false">
    {id === "claude" ? Array.from({ length: 12 }, (_, i) => {
      const angle = (i * 30 + 8) * Math.PI / 180;
      const length = i % 2 === 0 ? 9 : 6.75;
      return <line key={i} x1={9 + Math.cos(angle) * 1.35} y1={9 + Math.sin(angle) * 1.35}
        x2={9 + Math.cos(angle) * length} y2={9 + Math.sin(angle) * length} stroke="#d97757" strokeWidth="2.2" strokeLinecap="round" />;
    }) : id === "codex" ? <>
      <circle cx="9" cy="9" r="9" fill="#f2f2f2" />
      <path d="M5.04 5.04 8.64 9 5.04 12.96 M9.9 12.96H13.464" fill="none" stroke="#111" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </> : id === "kilo" ? <>
      <rect width="18" height="18" fill="#f8e45c" />
      <text x="9" y="9.5" textAnchor="middle" dominantBaseline="central" fill="#1e1e1e" fontFamily="Segoe UI, sans-serif" fontSize="13" fontWeight="700">K</text>
    </> : <circle cx="9" cy="9" r="6" fill="none" stroke="#8b909e" strokeWidth="1.5" />}
  </svg>;
}
