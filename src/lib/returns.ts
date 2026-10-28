import { randomBytes } from 'node:crypto';
import {
  RETURN_REASONS,
  type ReturnReason,
  type ReturnReportStatus,
  type ReturnResolution,
  type ReturnReportDto,
} from '@/lib/types';

/**
 * Return reports (RET-1, additive) — shared server-side rules.
 *
 * POLICY (owner): Green Gate does NOT do refunds. A return report is a
 * customer-service workflow only: it never moves money, never writes ledger
 * entries and never touches escrow or payouts. The ONLY resolution outcomes
 * are a replacement or store credit, decided by the administrator.
 *
 * WHO CAN REPORT: only the buyer of the order (order.buyerId, verified
 * server-side). Sellers and administrators cannot open a report on a
 * buyer's behalf; the administrator only reviews and resolves.
 */

/** Human-friendly report reference (RT-XXXXXXXX), unique-collision checked by the caller's retry. */
export function newReturnReference(): string {
  return `RT-${randomBytes(4).toString('hex').toUpperCase()}`;
}

/** Reasons a buyer may pick. Validated against this exact list. */
export function parseReturnReason(value: unknown): ReturnReason | null {
  const v = String(value ?? '').trim();
  return (RETURN_REASONS as string[]).includes(v) ? (v as ReturnReason) : null;
}

/** Buyer's own words: trim, collapse whitespace/control chars, cap length. */
export function cleanReturnDescription(raw: unknown): string {
  const text = String(raw ?? '')
    // Strip control characters (keep \n) — no exotic input may reach storage.
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.slice(0, 2000);
}

/**
 * Eligibility: a report may be opened on an order whose payment SETTLED and
 * which is still a live sale (not cancelled, not awaiting payment). This
 * covers the whole journey from confirmed to delivered — a buyer may spot
 * "not what I saw" in transit or after delivery.
 */
export function orderEligibleForReturnReport(order: { paymentStatus: string; status: string }): { eligible: boolean; why: string } {
  if (order.paymentStatus !== 'paid') {
    return { eligible: false, why: 'This order has no settled payment yet — it cannot be reported.' };
  }
  if (order.status === 'cancelled') {
    return { eligible: false, why: 'This order was cancelled — there is nothing to return.' };
  }
  return { eligible: true, why: '' };
}

/** Legal status transitions per actor. Everything not listed is refused (409). */
export const BUYER_REPORT_ACTIONS: Record<string, { from: ReturnReportStatus[]; to: ReturnReportStatus }> = {
  // The buyer may withdraw a report while it is still under review.
  withdraw: { from: ['open'], to: 'closed' },
  // The buyer confirms they have sent the parcel back (after approval).
  mark_sent_back: { from: ['approved'], to: 'in_return' },
};

/** Admin transitions (POST /api/admin action=return_report_update). */
export const ADMIN_REPORT_TRANSITIONS: Record<string, { from: ReturnReportStatus[]; needsResolution?: boolean }> = {
  approved: { from: ['open'] },
  rejected: { from: ['open'] },
  received: { from: ['approved', 'in_return'] },
  resolved: { from: ['approved', 'in_return', 'received'], needsResolution: true },
};

/** The ONLY allowed resolutions — a refund is not among them, by policy. */
export const ALLOWED_RESOLUTIONS: ReturnResolution[] = ['replacement', 'store_credit'];

export function parseResolution(value: unknown): ReturnResolution | null {
  const v = String(value ?? '').trim();
  return (ALLOWED_RESOLUTIONS as string[]).includes(v) ? (v as ReturnResolution) : null;
}

/** Short note field shared by admin actions and buyer withdrawals. */
export function cleanNote(raw: unknown, cap = 500): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, cap);
}

/** Shape a report row for the client (no internal columns leave the server). */
export function reportDto(r: {
  id: string; reference: string; orderId: string; orderItemId: string | null;
  reason: string; description: string; status: string; resolution: string | null;
  adminNote: string | null; createdAt: Date; updatedAt: Date; resolvedAt: Date | null;
}, extra?: Partial<ReturnReportDto>): ReturnReportDto {
  return {
    id: r.id,
    reference: r.reference,
    orderId: r.orderId,
    orderItemId: r.orderItemId,
    reason: r.reason as ReturnReportDto['reason'],
    description: r.description,
    status: r.status as ReturnReportDto['status'],
    resolution: (r.resolution as ReturnReportDto['resolution'] | null) ?? null,
    adminNote: r.adminNote,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    ...extra,
  };
}
