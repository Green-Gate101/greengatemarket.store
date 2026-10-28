'use client';

import { Button } from '@/components/ui/button';
import { navigate } from './header';

type Doc = 'terms' | 'privacy';

/** Opens the Terms at the refund policy (section 8). The terms view mounts
 * after the hash change and the app shell scrolls to the top first, so this
 * waits for the heading to exist, then scrolls to it. */
export function showRefundPolicy() {
  navigate({ name: 'terms' });
  let tries = 0;
  const step = () => {
    const el = document.getElementById('refund-policy');
    if (el) {
      el.scrollIntoView({ block: 'start' });
      return;
    }
    if (++tries < 60) requestAnimationFrame(step);
  };
  requestAnimationFrame(() => requestAnimationFrame(step));
}

export function LegalView({ doc }: { doc: Doc }) {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
      {doc === 'terms' ? <Terms /> : <Privacy />}
      <Button variant="outline" size="sm" className="mt-10" onClick={() => navigate({ name: 'store' })}>
        Back to marketplace
      </Button>
    </main>
  );
}

function H({ children, id }: { children: React.ReactNode; id?: string }) {
  return <h2 id={id} className="mt-8 scroll-mt-24 text-base font-bold">{children}</h2>;
}

function P({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={`mt-2 text-sm leading-relaxed text-muted-foreground${className ? ` ${className}` : ''}`}>{children}</p>;
}

function Terms() {
  return (
    <article>
      <h1 className="text-2xl font-bold">Terms of Service</h1>
      <P>Last updated: 28 October 2026</P>

      <H>1. Acceptance of terms</H>
      <P>By accessing or using Green Gate (the &ldquo;marketplace&rdquo;), you agree to these Terms of Service. If you do not agree, do not use the platform.</P>

      <H>2. Eligibility and accounts</H>
      <P>You must be able to form a binding contract to use Green Gate. You are responsible for the accuracy of your registration details, for keeping your password confidential, and for all activity under your account. Notify us immediately of unauthorised access.</P>

      <H>3. The marketplace role</H>
      <P>Green Gate is a venue that connects sellers and buyers — a marketplace for everyone. Contracts for the sale of goods are formed directly between the buyer and the seller. Green Gate is not the seller of record for third-party listings, but it operates the payment reconciliation, order tracking and dispute-reporting infrastructure described below.</P>

      <H>4. Sellers and listings</H>
      <P>Sellers must hold valid accounts, may hold one store, and must describe their products accurately and honestly. Listings must use genuine photographs of the actual product; uploading AI-generated product imagery is prohibited and technical measures reject such uploads. Sellers must keep prices, stock and availability current, dispatch orders as described, and honour the refund policy in section 8, including the rights South African law gives buyers.</P>

      <H>5. Buyers and orders</H>
      <P>Orders placed through Green Gate are offers to purchase. An order is confirmed when the payment provider confirms your payment — the seller&apos;s provider, or Green Gate&apos;s in-app GGPay. Prices and delivery charges are calculated and displayed at checkout before you commit. By placing an order you accept the refund policy in section 8.</P>
      <P><strong>Discount codes</strong> are offered by sellers for their own items and paid for by that seller. A code applies only to the items of the store that issued it, once per buyer, and only on the conditions shown when you apply it (for example a minimum spend, your first order on Green Gate, an end date or a limited number of uses). The discount is taken off the store&apos;s items, never off delivery, and is shown on your order.</P>

      <H>6. Payments</H>
      <P>You pay each order through the seller&apos;s own connected payment provider — PayFast, Ozow or Yoco — or through Green Gate&apos;s PayFast account where it is offered, or in-app with GGPay, Green Gate&apos;s own checkout. With GGPay your payment is captured by Green Gate and held in escrow for your order until the courier confirms collection; only then is it paid to the seller. Green Gate does not accept bank transfers (EFT) for orders and never stores card details. An order is confirmed automatically once the payment provider confirms the payment.</P>

      <H>7. Delivery</H>
      <P>Delivery is charged at checkout using live rates from The Courier Guy for each seller&apos;s parcels; a cart from several sellers is delivered in several parcels, each with its own delivery charge. Each seller dispatches their own order. Delivery times are estimates only. Risk passes on delivery to the address provided by the buyer.</P>
      <P><strong>Pickup points.</strong> Where every seller in your cart offers it, you can collect your order at a PAXI point (PEP stores) or from a Pudo locker instead. The seller sets the price and delivery time shown at checkout and sends your parcel to the point you enter; you collect it there with the details the provider sends you. Choose your point on the provider&apos;s own map (paxi.co.za, or The Courier Guy for Pudo lockers). Risk passes when the parcel is available for you to collect at that point.</P>

      <H id="refund-policy">8. No refunds</H>
      <P>
        <strong>All sales on Green Gate are final — no refunds.</strong> Green Gate and the sellers on Green Gate do not give refunds, exchanges or credit for change of mind, and order totals (including courier delivery) are payable in full at checkout. The only exceptions are the rights South African law gives every buyer, which no terms can take away:
      </P>
      <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground">
        <li><strong>Faulty, damaged or not as described</strong> — report it to the seller within 6 months of delivery (Consumer Protection Act, section 56); the seller repairs or replaces the item or refunds you, as the Act provides.</li>
        <li><strong>Wrong item sent, or the order never delivered</strong> — the seller refunds what you paid, including delivery.</li>
        <li><strong>7-day cooling-off for online orders</strong> — you may cancel within 7 days of receiving the goods (Electronic Communications and Transactions Act, section 44). Return the goods unused, in their original packaging, at your own cost; the seller refunds what you paid within 30 days. This does not apply to goods the Act excludes, such as perishable goods and goods made to your own specifications.</li>
      </ul>
      <P>
        <strong>Green Gate does not give refunds.</strong> This no-refund policy is platform-wide — Green Gate and every seller on it sell on a final-sale basis, and neither gives refunds, exchanges or credit for change of mind. Where the law itself requires money to be returned (the exceptions listed above, and only those), it goes back through the original payment method: on orders paid through the seller&apos;s PayFast, Ozow or Yoco the seller returns it; on orders paid in-app with GGPay it is returned from the money held for that order. Contact the seller first; if the seller does not help, contact Green Gate and we will step in.
      </P>

      <H id="buyer-protection">Buyer protection</H>
      <P>How you are protected when you buy on Green Gate:</P>
      <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground">
        <li><strong>Safe payment.</strong> You pay through PayFast, Ozow or Yoco — regulated payment providers — or in-app with GGPay, Green Gate&apos;s own checkout. Card details are never stored (GGPay keeps only the card brand and last four digits), your order is confirmed only when the payment provider confirms your payment, and with GGPay your money sits in escrow until the courier confirms collection before the seller is paid. Card payments also keep the protection your bank gives card holders.</li>
        <li><strong>Approved sellers.</strong> Every seller applies and is approved by Green Gate before they can sell. A <strong>Verified seller</strong> badge means Green Gate has also checked that seller&apos;s identity and bank details.</li>
        <li><strong>Real reviews.</strong> Only buyers who paid for an item can review it, and sellers cannot review their own items.</li>
        <li><strong>Your legal rights.</strong> Faulty, damaged or not-as-described goods (6 months), wrong or undelivered items, and the 7-day cooling-off for online orders — see section 8.</li>
        <li><strong>Help when it goes wrong.</strong> Contact the seller first. If they do not help, email <a className="text-primary hover:underline" href="mailto:support@greengate.co.za">support@greengate.co.za</a> with your order number: Green Gate steps in, and sellers who break these terms are suspended.</li>
      </ul>

      <H>9. Prohibited activities</H>
      <P>You may not upload AI-generated product images, counterfeit goods, illegal items or content that infringes others&apos; rights; scrape or abuse the platform; circumvent rate limits or security controls; interfere with other users; or use the marketplace for money laundering or fraud. Accounts engaged in prohibited activity may be suspended or terminated.</P>

      <H>10. Intellectual property</H>
      <P>The Green Gate name, logo and software are owned by Green Gate. Sellers retain rights to their own content but grant Green Gate a licence to host, display and promote that content within the marketplace.</P>

      <H>11. Limitation of liability</H>
      <P>To the extent permitted by law, Green Gate is not liable for indirect or consequential losses. Nothing in these terms limits liability that cannot lawfully be limited.</P>

      <H>12. Changes and contact</H>
      <P>These terms may be updated; material changes will be announced on the platform. Questions: <a className="text-primary hover:underline" href="mailto:legal@greengate.co.za">legal@greengate.co.za</a>.</P>
      <P className="italic">Note: this document is a platform operating policy prepared for launch, not a substitute for legal advice. Have it reviewed by a qualified legal professional before commercial scale-up.</P>
    </article>
  );
}

function Privacy() {
  return (
    <article>
      <h1 className="text-2xl font-bold">Privacy Policy</h1>
      <P>Last updated: 8 October 2026</P>

      <H>1. What we collect</H>
      <P><strong>Account data:</strong> name, email address, optional phone number, password (stored only as a salted scrypt hash), and profile image if you sign in with Google.</P>
      <P><strong>Seller data:</strong> store name, description, location, contact number, logo and the products you publish.</P>
      <P><strong>Order data:</strong> items purchased, delivery address, contact details, payment status and order history.</P>
      <P><strong>Usage data:</strong> product views, searches, cart and wishlist activity, used to power seller analytics and improve the marketplace.</P>

      <H>2. How we use data</H>
      <P>We use your data to operate your account, process orders, arrange delivery, send transactional email (order confirmations, status updates, verification and password resets), prevent fraud and abuse, and produce marketplace analytics. We do not sell personal information.</P>

      <H>3. Sharing</H>
      <P>Data is shared only with service providers that operate the platform under instruction: email delivery (Resend), search (Algolia), courier services (The Courier Guy), hosting (Vercel) and error monitoring. Each receives the minimum data required for its function.</P>

      <H>4. Security</H>
      <P>Passwords are never stored in plain text. Sessions use signed, httpOnly cookies. Privileged actions require server-side role checks and are recorded in an internal audit log. Secrets are kept in environment variables and never embedded in client code.</P>

      <H>5. Retention</H>
      <P>Account and order records are retained while your account is active and for record-keeping thereafter. You may request deletion of your account; order records required for transaction history may be retained in anonymised form.</P>

      <H>6. Your choices</H>
      <P>You may update your profile, request an export or deletion of your data, and opt out of non-essential email at any time by contacting <a className="text-primary hover:underline" href="mailto:privacy@greengate.co.za">privacy@greengate.co.za</a>.</P>
      <P><strong>Cookies:</strong> the cookie banner shown on your first visit lets you accept or decline optional cookies. Essential storage (your session, your cart and your security preferences) is always required for the store to function. Your choice is kept on your device and can be changed at any time via &ldquo;Cookie preferences&rdquo; in the footer. Declining optional cookies disables preference storage and personalised picks based on anonymous browsing.</P>

      <H>7. Changes</H>
      <P>We will post any changes to this policy on this page with a new effective date.</P>
      <P className="italic">Note: this policy describes current practice. Have it reviewed by a qualified legal professional against the data-protection laws that apply to you before commercial scale-up.</P>
    </article>
  );
}
