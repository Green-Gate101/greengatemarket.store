'use client';

import { Button } from '@/components/ui/button';
import { navigate } from './header';

type Doc = 'terms' | 'privacy';

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

function H({ children }: { children: React.ReactNode }) {
  return <h2 className="mt-8 text-base font-bold">{children}</h2>;
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{children}</p>;
}

function Terms() {
  return (
    <article>
      <h1 className="text-2xl font-bold">Terms of Service</h1>
      <P>Last updated: {new Date().toLocaleDateString('en-ZA', { year: 'numeric', month: 'long', day: 'numeric' })}</P>

      <H>1. Acceptance of terms</H>
      <P>By accessing or using Green Gate (the &ldquo;marketplace&rdquo;), you agree to these Terms of Service. If you do not agree, do not use the platform.</P>

      <H>2. Eligibility and accounts</H>
      <P>You must be able to form a binding contract to use Green Gate. You are responsible for the accuracy of your registration details, for keeping your password confidential, and for all activity under your account. Notify us immediately of unauthorised access.</P>

      <H>3. The marketplace role</H>
      <P>Green Gate is a venue that connects independent sellers with buyers. Contracts for the sale of goods are formed directly between the buyer and the seller. Green Gate is not the seller of record for third-party listings, but it operates the payment reconciliation, order tracking and dispute-reporting infrastructure described below.</P>

      <H>4. Sellers and listings</H>
      <P>Sellers must hold valid accounts, may hold one store, and must describe their products accurately and honestly. Listings must use genuine photographs of the actual product; uploading AI-generated product imagery is prohibited and technical measures reject such uploads. Sellers must keep prices, stock and availability current, dispatch orders as described, and honour the returns policy shown on their store.</P>

      <H>5. Buyers and orders</H>
      <P>Orders placed through Green Gate are offers to purchase. An order is accepted when the seller confirms the buyer&apos;s payment. Prices and delivery charges are calculated and displayed at checkout before you commit.</P>

      <H>6. Payments</H>
      <P>Green Gate currently collects payment by bank transfer (EFT) using the order number as payment reference. An order only becomes a confirmed sale once the seller or marketplace confirms that the transfer has been received. Green Gate does not store card details. Additional payment providers may be introduced and will be governed by these terms as updated.</P>

      <H>7. Delivery</H>
      <P>Delivery is performed by courier providers engaged by Green Gate, including The Courier Guy. Delivery estimates are estimates only. Risk passes on delivery to the address provided by the buyer.</P>

      <H>8. Returns and refunds</H>
      <P>Buyers may report problems within 7 days of delivery. Where a product is materially not as described, damaged or faulty, the seller is responsible for the refund or replacement. Approved refunds are returned via the original payment channel.</P>

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
      <P>Last updated: {new Date().toLocaleDateString('en-ZA', { year: 'numeric', month: 'long', day: 'numeric' })}</P>

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
