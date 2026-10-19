/**
 * Payment processor logo badges for the admin console — inline SVG,
 * self-hosted, self-contained (the console shares no code with the
 * marketplace, so this is the console's own copy of the same badges).
 *
 * Same brand marks as the marketplace: PayFast teal, Ozow violet, Yoco
 * charcoal + lime dot, Mastercard circles, Visa navy, a GGPay wordmark,
 * bank-transfer and hosted-link marks. Inline SVG can never fail to load,
 * keeps the console free of third-party CDNs and renders crisply at every
 * DPI. Chips use inline styles because the console is plain CSS (no Tailwind).
 */

import type { ReactNode } from 'react';

export interface LogoBadgeProps {
  size?: 'sm' | 'md';
  className?: string;
}

const chipStyle: React.CSSProperties = {
  display: 'inline-flex',
  flexShrink: 0,
  alignItems: 'center',
  justifyContent: 'center',
  verticalAlign: 'middle',
  background: '#ffffff',
  border: '1px solid rgba(0,0,0,0.12)',
  borderRadius: 6,
  boxShadow: '0 1px 1px rgba(0,0,0,0.04)',
};

function Chip({
  children,
  label,
  size,
  className = '',
}: {
  children: ReactNode;
  label: string;
  size: 'sm' | 'md';
  className?: string;
}) {
  return (
    <span
      role="img"
      aria-label={label}
      style={{ ...chipStyle, height: size === 'sm' ? 20 : 28, padding: size === 'sm' ? '0 6px' : '0 10px' }}
      className={className}
    >
      {children}
    </span>
  );
}

const wordmarkFont = "system-ui, -apple-system, 'Segoe UI', sans-serif";

/** PayFast — wordmark in PayFast teal on white. */
export function PayFastLogo({ size = 'sm', className }: LogoBadgeProps) {
  return (
    <Chip label="PayFast" size={size} className={className}>
      <svg viewBox="0 0 56 16" style={{ height: size === 'sm' ? 12 : 16 }} aria-hidden focusable="false">
        <text x="0" y="12.5" fontFamily={wordmarkFont} fontSize="13" fontWeight="700" fill="#0f7f8c" letterSpacing="0.2">
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
      <svg viewBox="0 0 40 16" style={{ height: size === 'sm' ? 12 : 16 }} aria-hidden focusable="false">
        <text x="0" y="12.5" fontFamily={wordmarkFont} fontSize="13" fontWeight="700" fill="#6f2c91" letterSpacing="0.3">
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
      <svg viewBox="0 0 44 16" style={{ height: size === 'sm' ? 12 : 16 }} aria-hidden focusable="false">
        <text x="0" y="12.5" fontFamily={wordmarkFont} fontSize="13" fontWeight="700" fill="#1f2429" letterSpacing="0.3">
          yoco
        </text>
        <circle cx="39.5" cy="10.5" r="2.5" fill="#c4f82a" />
      </svg>
    </Chip>
  );
}

/** Mastercard — the two intersecting circles. */
export function MastercardLogo({ size = 'sm', className }: LogoBadgeProps) {
  return (
    <Chip label="Mastercard" size={size} className={className}>
      <svg viewBox="0 0 32 20" style={{ height: size === 'sm' ? 13 : 18 }} aria-hidden focusable="false">
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
      <svg viewBox="0 0 40 16" style={{ height: size === 'sm' ? 12 : 16 }} aria-hidden focusable="false">
        <text x="0" y="13" fontFamily={wordmarkFont} fontSize="13.5" fontWeight="800" fontStyle="italic" fill="#1a1f71" letterSpacing="0.5">
          VISA
        </text>
      </svg>
    </Chip>
  );
}

/** GGPay — the marketplace's own in-app card engine, Green Gate green. */
export function GGPayLogo({ size = 'sm', className }: LogoBadgeProps) {
  return (
    <Chip label="GGPay card (in-app)" size={size} className={className}>
      <svg viewBox="0 0 52 16" style={{ height: size === 'sm' ? 12 : 16 }} aria-hidden focusable="false">
        <text x="0" y="12.5" fontFamily={wordmarkFont} fontSize="13" fontWeight="700" fill="#1d6b3f" letterSpacing="0.2">
          GGPay
        </text>
        <circle cx="46" cy="10.5" r="2.5" fill="#3fae6a" />
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
        style={{ height: s, width: s, color: 'var(--muted, #6b7280)' }}
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
        style={{ height: s, width: s, color: 'var(--muted, #6b7280)' }}
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
 * The badge for a payment provider value as recorded on Payment rows
 * (ggpay_card | payfast | payfast_seller | ozow | yoco | mastercard |
 * bank_transfer | admin | anything unknown → neutral mark).
 */
export function ProcessorLogo({
  provider,
  size = 'sm',
  className,
}: LogoBadgeProps & { provider: string }) {
  switch (provider) {
    case 'ggpay_card':
      return <GGPayLogo size={size} className={className} />;
    case 'payfast':
    case 'payfast_seller':
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

/** Card-scheme badges (Visa + Mastercard) — the "we accept" strip. */
export function CardSchemeLogos({ size = 'sm', className = '' }: LogoBadgeProps) {
  return (
    <span className={className} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <VisaLogo size={size} />
      <MastercardLogo size={size} />
    </span>
  );
}

/**
 * The full "we settle through" strip — every processor the marketplace
 * settles payments through, exactly the logos buyers see at checkout.
 */
export function ProcessorLogoStrip({ size = 'sm', className = '' }: LogoBadgeProps) {
  return (
    <span className={className} style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
      <GGPayLogo size={size} />
      <PayFastLogo size={size} />
      <OzowLogo size={size} />
      <YocoLogo size={size} />
      <VisaLogo size={size} />
      <MastercardLogo size={size} />
      <BankLogo size={size} />
    </span>
  );
}
