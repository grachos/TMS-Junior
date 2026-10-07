/**
 * Konekto - Brand mark + wordmark. The mark is a vector redraw of the logo
 * (chevron, road fork and the two circuit nodes), not a trace of the original
 * artwork; swap in the designer's SVG paths here when available.
 *
 * tone: 'light' for light backgrounds, 'dark' for navy ones, 'auto' to follow
 * the app theme (the `.dark` class) — used in the page header.
 */

const NAVY = '#142B54';
const CYAN = '#09B8CD';
const GREEN = '#11B787';

type Tone = 'light' | 'dark' | 'auto';

// Full class names (not built dynamically) so Tailwind's scanner keeps them.
const TONE: Record<Tone, { chev: string; lower: string; road: string }> = {
  light: { chev: 'fill-brand-navy', lower: 'fill-[#0580A1]', road: 'stroke-brand-navy' },
  dark: { chev: 'fill-white', lower: 'fill-[#1690B3]', road: 'stroke-[#3E63A8]' },
  auto: {
    chev: 'fill-brand-navy dark:fill-white',
    lower: 'fill-[#0580A1] dark:fill-[#1690B3]',
    road: 'stroke-brand-navy dark:stroke-[#3E63A8]',
  },
};

export function KonektoMark({ size = 24, tone = 'light', className }: { size?: number; tone?: Tone; className?: string }) {
  const t = TONE[tone];
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-label="Konekto" className={className}>
      <path d="M2 8H26L56 50L26 92H2L32 50Z" className={t.chev} />
      <path d="M26 8H40L70 50H56Z" fill={CYAN} />
      <path d="M56 50H70L40 92H26Z" className={t.lower} />
      {/* Road fork: stem heading east, splitting back toward the chevron tip. */}
      <g fill="none" strokeWidth="9" strokeLinejoin="round" className={t.road}>
        <path d="M99 50H82M82 50C74 50 72 41 66 38M82 50C74 50 72 59 66 62" />
      </g>
      <g fill="none" stroke="#fff" strokeWidth="1.6" strokeDasharray="4 3">
        <path d="M98 50H82M82 50C74 50 72 41 67 38.5M82 50C74 50 72 59 67 61.5" />
      </g>
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
