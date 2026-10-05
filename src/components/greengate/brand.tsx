import { cn } from '@/lib/utils';

/** Green Gate gate mark — an original gateway glyph, not a stock icon. */
export function GateMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={cn('h-6 w-6', className)} aria-hidden>
      <path d="M4 28V14C4 8 9 4 16 4s12 4 12 10v14" stroke="currentColor" strokeWidth="2.6" strokeLinecap="square" />
      <path d="M10 28v-9a6 6 0 0 1 12 0v9" stroke="currentColor" strokeWidth="2.6" strokeLinecap="square" />
      <path d="M2 28h28" stroke="currentColor" strokeWidth="2.6" strokeLinecap="square" />
    </svg>
  );
}

export function Logo({ className, onClick }: { className?: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md', className)}
      aria-label="Green Gate home"
    >
      <span className="text-primary">
        <GateMark className="h-6 w-6" />
      </span>
      <span className="text-[15px] font-bold tracking-[0.18em] text-foreground">
        GREEN <span className="text-primary">GATE</span>
      </span>
    </button>
  );
}
