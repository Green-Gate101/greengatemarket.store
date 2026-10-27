# Delivery — The Courier Guy

(Pickup points — PAXI and Pudo — are described at the end.)

## What works today

**Live quotes.** Checkout asks The Courier Guy's Ship Logic v2 gateway
(`api.portal.thecourierguy.co.za/v2/rates`) for real prices, for example Economy, Priority
and Same Day Express. The merchant token `COURIER_GUY_API_KEY` and `COURIER_GUY_ACCOUNT_ID`
are set in production, so quotes use the merchant's rates.

**Real parcels.** Every product has the seller's declared weight and box size. Each unit in
the cart becomes one parcel (at most 20 per store), and The Courier Guy prices the greater of
actual and volumetric weight.

**Per seller.** Each seller ships from their own town. `/api/shipping` groups the cart by
store and quotes each store's leg separately. An option's price is the sum across stores:
for each store, the same service if it offers it, otherwise that store's cheapest. This is
exactly what `/api/checkout` charges, so the delivery shown before "Place order" is the
delivery charged. (Before October 2026, a two-seller cart was quoted as one parcel set from
the first seller's town and showed less than was charged.)

**The buyer pays delivery in the app.** The delivery fee is part of each order's total and is
paid with the goods, through the seller's processor.

**Quote once typing pauses.** The checkout waits 0.7 s after the last keystroke before
quoting. Before, every keystroke sent a quote: about 50 for one address, which hit the
per-IP limit and showed "We could not get courier rates". The per-IP ceiling is 90 per minute,
because mobile carriers put many buyers behind one IP.

**Fallback.** If the gateway is down, or an address can't be mapped to a South African city,
a flat table is used (Economy R45, Standard R75, Express R130) so checkout never blocks. The
server re-quotes at checkout and charges what it gets then.

**Delivery times** come from The Courier Guy's service description: the sentence about
delivery time (for Same Day: "Our standard turnaround time is 8-10 hours, subject to flight availability"), never the sender's booking instruction, surcharge or contact notes (`tcgEta`).

## What is NOT built yet

**Booking the collection (waybill/label) inside the app.** Today the seller books the
collection themselves after an order is paid. The order shows the chosen service, for
example "Economy (thecourierguy)", and the delivery amount the buyer paid.

Open decision for the owner: should bookings go through **each seller's own Courier Guy
account**, or through **one marketplace account**, where the marketplace pays The Courier Guy
and keeps the delivery fee? Do not build booking until this is decided — it changes who is
billed and who receives the delivery money.

## Files

- `src/lib/shipping.ts`: address parsing, gateway call, fallback table, `tcgEta`.
- `src/app/api/shipping/route.ts`: per-store quote for the checkout screen.
- `src/app/api/checkout/route.ts`: per-store re-quote and charge.
- `src/components/greengate/cart-sheet.tsx`: delivery options at checkout.

## Health

`/api/health` reports "delivery (The Courier Guy)". The admin console's **API & billing** tab
counts real quote calls (`trackApiUsage('courier_guy')`).

## Pickup points (PAXI, Pudo)

Sellers can offer collection at a **PAXI point** (PEP stores) and/or a **Pudo locker** (The Courier
Guy) next to door delivery, in the dashboard card "Pickup points". The seller sets the price buyers
pay and the delivery time they book; the published prices (October 2026: PAXI standard bag
7–9 business days R59.95; Pudo extra-small locker-to-locker about R59) are only suggestions.

At checkout the option appears only when every seller in the cart offers it. The buyer picks a point
on the provider's own map (paxi.co.za/paxi-points, or The Courier Guy's locker page) and types its
name or code; the order's delivery address becomes `PAXI point: …` / `Pudo locker: …` and the seller
sends the parcel there. There is no booking API connected — the seller books the PAXI / Pudo send
themselves, exactly as for courier collections today.
