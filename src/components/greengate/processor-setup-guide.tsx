'use client';

import { useState } from 'react';
import { Check, Copy, ListChecks } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

/**
 * Step-by-step setup for the processor a seller picked, with the exact Green
 * Gate links to hand to that processor (website, store page, notify/webhook
 * URL, return/cancel pages). Links are built from the address the seller is
 * using, so they are always this marketplace's real URLs.
 *
 * Facts match the integration: PayFast and Ozow receive the notify URL with
 * every payment Green Gate creates (nothing to paste in their dashboards
 * unless their support asks); Yoco payments are confirmed when the buyer
 * returns, with the webhook as an optional extra.
 */

type Guide = { title: string; steps: string[]; links: { label: string; path: string }[]; notes: string[] };

function guideFor(provider: string, storePath: string | null): Guide | null {
  const site = { label: 'Website (marketplace)', path: '/' };
  const store = storePath ? [{ label: 'Your store page', path: storePath }] : [];
  const orders = { label: 'Return / success page', path: '/#/orders' };
  switch (provider) {
    case 'payfast':
      return {
        title: 'How to accept PayFast payments (card and instant EFT)',
        steps: [
          'Create a PayFast merchant account with the "Sign up" button above and complete PayFast’s verification (ID, bank account) so your account is LIVE — sandbox accounts cannot take real money.',
          'In your PayFast dashboard open Settings → Developer Settings (called Integration on some accounts). Your Merchant ID and Merchant Key are shown there. Set a Salt Passphrase (any secret phrase) on the same page — Green Gate needs it to verify every payment.',
          'Copy the Merchant ID, Merchant Key and passphrase into the three fields here exactly as they appear in PayFast (no extra spaces) and press "Save payment details".',
          'Check the status at the top of this card says "Buyers can pay you with: PayFast". Buyers then pay on PayFast’s secure page and come back to Green Gate; the order confirms automatically once PayFast verifies the payment.',
        ],
        links: [site, ...store, { label: 'Notify URL (ITN)', path: '/api/payments/payfast/itn' }, orders, { label: 'Cancel page', path: '/#/orders' }],
        notes: [
          'Green Gate sends the Notify URL with every payment, so you do not need to enter it in PayFast — it is listed in case PayFast support asks for it.',
          'If PayFast asks for your website during sign-up, give them your store page link (or the marketplace website).',
          'The money goes straight into your PayFast account.',
        ],
      };
    case 'ozow':
      return {
        title: 'How to accept Ozow instant EFT',
        steps: [
          'Register as an Ozow merchant with the "Sign up" button above. When Ozow sets up your account, ask for "Payments API" credentials: a Site Code, a Private Key and an API Key.',
          'Give Ozow the links below when they ask for your website and notification URL.',
          'In your Ozow merchant dashboard open Merchants → Merchant Details for the Private Key and API Key; the Site Code is on your Site page. Copy all three into the fields here, then press "Save payment details". If you cannot find them, email support@ozow.com and ask for your live Site Code, Private Key and API Key.',
          'Check the status at the top of this card says "Buyers can pay you with: Ozow". Buyers pick their bank on Ozow’s secure page; the order confirms automatically once Ozow verifies the payment.',
        ],
        links: [site, ...store, { label: 'Notify URL', path: '/api/payments/ozow/notify' }, orders, { label: 'Cancel page', path: '/#/orders' }, { label: 'Error page', path: '/#/orders' }],
        notes: [
          'Green Gate does not yet support Ozow’s newer "One API" (Client ID + Client Secret). If Ozow only gives you those, ask them for Payments API credentials (Site Code, Private Key, API Key).',
          'The money goes straight into your Ozow-linked bank account.',
        ],
      };
    case 'yoco':
    case 'mastercard':
      return {
        title: 'How to accept card payments with Yoco (Mastercard and Visa)',
        steps: [
          'Create a Yoco account with the "Sign up" button above and finish Yoco’s verification so online payments are enabled on your account.',
          'In the Yoco Business Portal open Sell Online → Payment Gateway (in the Yoco app: Sales → Payment Gateway) and copy the LIVE secret key — it starts with sk_live_. Test keys (sk_test_) cannot take real money and are refused.',
          'Paste the key into the field here and press "Save payment details".',
          'Check the status at the top of this card says "Buyers can pay you with: Yoco". Buyers pay on Yoco’s secure card page; the order confirms automatically once Green Gate verifies the payment with Yoco.',
        ],
        links: [site, ...store, { label: 'Webhook URL (optional)', path: '/api/payments/yoco/webhook' }, { label: 'Success page', path: '/#/orders' }],
        notes: [
          'You do not need a webhook — Green Gate checks every payment with Yoco when the buyer returns. If you add one in Yoco, use the Webhook URL above.',
          'The money goes straight into your Yoco account.',
        ],
      };
    case 'bank_transfer':
      return {
        title: 'How bank transfer (EFT) works',
        steps: [
          'Add your bank name, account holder and account number in "Payout bank account" below and save.',
          'Buyers of your unpaid orders see those bank details, the exact amount and the order number to use as the payment reference.',
          'When the money shows in your bank account, open the order in your dashboard and confirm the payment — the buyer is notified and you can ship.',
        ],
        links: [site, ...store],
        notes: ['Only confirm a payment once the money has actually cleared in your account.'],
      };
    case 'other':
      return {
        title: 'How to use your own payment page',
        steps: [
          'Create a payment page or payment link with your provider (it must start with https://).',
          'Paste it into "Your payment page link" and press "Save payment details".',
          'Buyers see a "Pay on your payment page" button with their order number as the reference. Confirm the payment in your dashboard once the money arrives.',
        ],
        links: [site, ...store, { label: 'Return page (after payment)', path: '/#/orders' }],
        notes: ['Orders paid this way are confirmed by you, not automatically.'],
      };
    default:
      return null;
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  // Older browsers / non-secure contexts: hidden textarea + execCommand.
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function ProcessorSetupGuide({ provider, storeSlug }: { provider: string; storeSlug?: string | null }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState<string | null>(null);
  const guide = guideFor(provider, storeSlug ? `/store/${encodeURIComponent(storeSlug)}` : null);
  if (!guide) return null;
  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  return (
    <div className="mt-4 rounded-md border bg-secondary/50 p-3 text-xs sm:p-4" data-testid={`setup-guide-${provider}`}>
      <p className="flex items-center gap-2 text-sm font-semibold">
        <ListChecks className="h-4 w-4 shrink-0 text-primary" aria-hidden /> {guide.title}
      </p>
      <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-foreground/90">
        {guide.steps.map((s) => <li key={s}>{s}</li>)}
      </ol>
      <p className="mt-3 font-semibold">Your Green Gate links — give these to the processor if they ask:</p>
      <ul className="mt-1.5 space-y-1.5">
        {guide.links.map((l) => {
          const url = `${origin}${l.path}`;
          return (
            <li key={l.label} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
              <span className="shrink-0 text-muted-foreground sm:w-44">{l.label}</span>
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <code className="min-w-0 flex-1 break-all rounded border bg-background px-2 py-1 font-mono text-[11px]">{url}</code>
                <button
                  type="button"
                  className="inline-flex min-h-[36px] shrink-0 items-center gap-1 rounded border bg-background px-2 text-[11px] font-semibold text-primary hover:bg-primary/5"
                  onClick={async () => {
                    const ok = await copyText(url);
                    if (ok) {
                      setCopied(l.label);
                      setTimeout(() => setCopied((c) => (c === l.label ? null : c)), 2000);
                    } else {
                      toast({ title: 'Copy the link', description: url });
                    }
                  }}
                  aria-label={`Copy ${l.label}`}
                >
                  {copied === l.label ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
                  {copied === l.label ? 'Copied' : 'Copy'}
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      {guide.notes.length > 0 && (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-muted-foreground">
          {guide.notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}
    </div>
  );
}
