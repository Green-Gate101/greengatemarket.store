import { db } from '@/lib/db';

/**
 * In-app notifications. Every marketplace event a user should know about —
 * order placed, payment confirmed, fulfilment progress, new sales — creates a
 * persistent notification row served by /api/notifications and the header bell.
 *
 * Delivery is best-effort: notify() never throws into the caller's flow, so
 * order placement and fulfilment can never be broken by a notification issue
 * (same contract as transactional email).
 */

export type NotificationType =
  | 'order_placed'
  | 'new_order'
  | 'payment_confirmed'
  | 'order_status'
  | 'welcome'
  | 'review_received'
  | 'store_approved'
  | 'store_declined'
  | 'account_banned';

export interface NotifyInput {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  /** In-app hash route the bell navigates to, e.g. "/orders". */
  link?: string;
}

export async function notify(input: NotifyInput): Promise<void> {
  try {
    if (!input.userId) return;
    await db.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body,
        link: input.link ?? null,
      },
    });
  } catch (e) {
    console.error('notify failed:', e instanceof Error ? e.message : e);
  }
}
