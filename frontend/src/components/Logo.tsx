/**
 * Konekto - Brand mark + wordmark. The mark is a vector redraw of the logo
 * (chevron, route fork and the two circuit nodes), not a trace of the original
 * artwork; swap in the designer's SVG paths here when available.
 */

const NAVY = '#142B54';
const CYAN = '#09B8CD';
const GREEN = '#11B787';

export function KonektoMark({ size = 24, onDark = false, className }: { size?: number; onDark?: boolean; className?: string }) {
  const chev = onDark ? '#FFFFFF' : NAVY;
  const lower = onDark ? '#1690B3' : '#0580A1';
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-label="Konekto" className={className}>
      <path d="M2 8H26L56 50L26 92H2L32 50Z" fill={chev} />
      <path d="M26 8H40L70 50H56Z" fill={CYAN} />
      <path d="M56 50H70L40 92H26Z" fill={lower} />
      <path d="M60 36C64 24 72 18 84 18" stroke={CYAN} strokeWidth="7" fill="none" strokeLinecap="round" />
      <path d="M60 64C64 76 72 82 84 82" stroke={GREEN} strokeWidth="7" fill="none" strokeLinecap="round" />
      <circle cx="88" cy="18" r="10" fill={CYAN} />
      <circle cx="88" cy="18" r="4.5" fill={NAVY} />
      <circle cx="88" cy="82" r="10" fill={GREEN} />
      <circle cx="88" cy="82" r="4.5" fill={NAVY} />
    </svg>
  );
}

/** "konek" in the surrounding text color + "to" in brand cyan, like the logo. */
export function KonektoWordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`font-extrabold lowercase tracking-tight ${className}`}>
      konek<span className="text-brand-cyan">to</span>
    </span>
  );
}
