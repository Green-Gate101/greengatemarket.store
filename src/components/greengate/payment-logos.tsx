/**
 * Payment processor logo badges — inline SVG, self-hosted.
 *
 * Shown everywhere payment methods are surfaced, the way mainstream
 * ecommerce platforms do: the seller processor picker, the buyer pay
 * buttons and the in-app payment page.
 *
 * Deliberately NOT remote images: inline SVG can never fail to load on any
 * device or network, keeps the app free of third-party CDN dependencies and
 * renders crisply at every DPI. Badges are simplified brand marks (wordmark
 * in the platform's colours) — recognizable without pretending to be the
 * official assets.
 */

export interface LogoBadgeProps {
  /** 'sm' fits inside buttons/select rows; 'md' for trust strips. */
  size?: 'sm' | 'md';
  className?: string;
}

/** Chip shell — white card with a soft border, the standard badge look. */
function Chip({
  children,
  label,
  size,
  className = '',
}: {
  children: React.ReactNode;
  label: string;
  size: 'sm' | 'md';
  className?: string;
}) {
  return (
    <span
      role="img"
      aria-label={label}
      className={`inline-flex shrink-0 items-center justify-center rounded-md border border-black/10 bg-white shadow-sm ${
        size === 'sm' ? 'h-5 px-1.5' : 'h-7 px-2.5'
      } ${className}`}
    >
      {children}
    </span>
  );
}

/** PayFast — wordmark in PayFast teal on white. */
export function PayFastLogo({ size = 'sm', className }: LogoBadgeProps) {
  return (
    <Chip label="PayFast" size={size} className={className}>
      <svg viewBox="0 0 56 16" className={size === 'sm' ? 'h-3' : 'h-4'} aria-hidden focusable="false">
        <text
          x="0"
          y="12.5"
          fontFamily="system-ui, -apple-system, 'Segoe UI', sans-serif"
          fontSize="13"
          fontWeight="700"
          fill="#0f7f8c"
          letterSpacing="0.2"
        >
          Pay
          <tspan fill="#28a3ae">Fast</tspan>
        </text>
      </svg>
    </Chip>
  );
}

/** Ozow — lowercase wordmark in Ozow violet. */
export function OzowLogo({ size = 'sm', className }: LogoBadgeProps) {
  return (
    <Chip label="Ozow instant EFT" size={size} className={className}>
      <svg viewBox="0 0 40 16" className={size === 'sm' ? 'h-3' : 'h-4'} aria-hidden focusable="false">
        <text
          x="0"
          y="12.5"
          fontFamily="system-ui, -apple-system, 'Segoe UI', sans-serif"
          fontSize="13"
          fontWeight="700"
          fill="#6f2c91"
          letterSpacing="0.3"
        >
          ozow
        </text>
      </svg>
    </Chip>
  );
}

/** Yoco — lowercase wordmark in Yoco charcoal with a lime accent dot. */
export function YocoLogo({ size = 'sm', className }: LogoBadgeProps) {
  return (
    <Chip label="Yoco" size={size} className={className}>
      <svg viewBox="0 0 44 16" className={size === 'sm' ? 'h-3' : 'h-4'} aria-hidden focusable="false">
        <text
          x="0"
          y="12.5"
          fontFamily="system-ui, -apple-system, 'Segoe UI', sans-serif"
          fontSize="13"
          fontWeight="700"
          fill="#1f2429"
          letterSpacing="0.3"
        >
          yoco
        </text>
        <circle cx="39.5" cy="10.5" r="2.5" fill="#c4f82a" />
      </svg>
    </Chip>
  );
}

/** Mastercard — the two intersecting circles. */
export function MastercardLogo({ size = 'sm', className }: LogoBadgeProps) {
  const s = size === 'sm' ? 13 : 18;
  return (
    <Chip label="Mastercard" size={size} className={className}>
      <svg
        viewBox="0 0 32 20"
        style={{ height: s }}
        aria-hidden
        focusable="false"
      >
        <circle cx="12" cy="10" r="8.5" fill="#eb001b" />
        <circle cx="20" cy="10" r="8.5" fill="#f79e1b" />
        <path d="M16 3.6a8.5 8.5 0 0 1 0 12.8 8.5 8.5 0 0 1 0-12.8z" fill="#ff5f00" />
      </svg>
    </Chip>
  );
}

/** Visa — italic wordmark in Visa navy. */
export function VisaLogo({ size = 'sm', className }: LogoBadgeProps) {
  return (
    <Chip label="Visa" size={size} className={className}>
      <svg viewBox="0 0 40 16" className={size === 'sm' ? 'h-3' : 'h-4'} aria-hidden focusable="false">
        <text
          x="0"
          y="13"
          fontFamily="system-ui, -apple-system, 'Segoe UI', sans-serif"
          fontSize="13.5"
          fontWeight="800"
          fontStyle="italic"
          fill="#1a1f71"
          letterSpacing="0.5"
        >
          VISA
        </text>
      </svg>
    </Chip>
  );
}

/** Bank transfer — neutral building/columns mark. */
export function BankLogo({ size = 'sm', className }: LogoBadgeProps) {
  const s = size === 'sm' ? 12 : 16;
  return (
    <Chip label="Bank transfer (EFT)" size={size} className={className}>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ height: s, width: s }}
        className="text-muted-foreground"
        aria-hidden
        focusable="false"
      >
        <path d="M3 21h18" />
        <path d="M5 21V10l7-6 7 6v11" />
        <path d="M9 21v-6h6v6" />
        <path d="M9 12h.01M15 12h.01" />
      </svg>
    </Chip>
  );
}

/** Hosted payment-page link — neutral chain-link mark. */
export function LinkLogo({ size = 'sm', className }: LogoBadgeProps) {
  const s = size === 'sm' ? 12 : 16;
  return (
    <Chip label="Hosted payment page" size={size} className={className}>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ height: s, width: s }}
        className="text-muted-foreground"
        aria-hidden
        focusable="false"
      >
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </svg>
    </Chip>
  );
}

/**
 * The badge for a processor value (PAYMENT_PROVIDER_LABELS key). Unknown or
 * legacy values degrade to the neutral hosted-page mark.
 */
export function ProcessorLogo({
  provider,
  size = 'sm',
  className,
}: LogoBadgeProps & { provider: string }) {
  switch (provider) {
    case 'payfast':
      return <PayFastLogo size={size} className={className} />;
    case 'ozow':
      return <OzowLogo size={size} className={className} />;
    case 'yoco':
      return <YocoLogo size={size} className={className} />;
    case 'mastercard':
      return <MastercardLogo size={size} className={className} />;
    case 'bank_transfer':
      return <BankLogo size={size} className={className} />;
    default:
      return <LinkLogo size={size} className={className} />;
  }
}

/**
 * Card-scheme badges (Mastercard + Visa) — the "we accept" strip every
 * ecommerce checkout shows next to card payments.
 */
export function CardSchemeLogos({ size = 'sm', className = '' }: LogoBadgeProps) {
  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      <VisaLogo size={size} />
      <MastercardLogo size={size} />
    </span>
  );
}
