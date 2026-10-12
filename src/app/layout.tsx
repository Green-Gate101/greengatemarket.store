import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "@/components/greengate/providers";

const SITE_URL = process.env.NEXTAUTH_URL ?? "https://greengatemarket.store";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Green Gate — Shop anything from independent stores",
    template: "%s — Green Gate",
  },
  description:
    "Green Gate is a multi-vendor marketplace for anything and everything. Real sellers, real products, nationwide courier delivery. Soo good you wanna gate keep.",
  keywords: ["marketplace", "multi-vendor", "shop anything", "sell anything", "e-commerce", "Green Gate", "South Africa"],
  openGraph: {
    title: "Green Gate — Shop anything, sell anything",
    description: "Everything you need from independent stores across South Africa — with real sellers, nationwide delivery and straightforward returns. Soo good you wanna gate keep.",
    siteName: "Green Gate",
    type: "website",
    url: SITE_URL,
    images: [{ url: "/og-image.jpg", width: 1344, height: 768, alt: "Green Gate — Multi-vendor marketplace" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Green Gate — Shop anything, sell anything",
    description: "Everything you need from independent stores across South Africa — with real sellers, nationwide delivery and straightforward returns.",
    images: ["/og-image.jpg"],
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased bg-background text-foreground">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
