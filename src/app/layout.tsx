import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "@/components/greengate/providers";

const SITE_URL = process.env.NEXTAUTH_URL ?? "https://green-gate.vercel.app";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Green Gate — Multi-vendor fashion & lifestyle marketplace",
    template: "%s — Green Gate",
  },
  description:
    "Green Gate is a multi-vendor marketplace for fashion, lifestyle and general merchandise. Real sellers, real products, nationwide courier delivery.",
  keywords: ["marketplace", "fashion", "multi-vendor", "e-commerce", "Green Gate", "South Africa"],
  openGraph: {
    title: "Green Gate — Multi-vendor marketplace",
    description: "Shop fashion and lifestyle from independent stores. Sellers get real analytics and nationwide courier delivery.",
    siteName: "Green Gate",
    type: "website",
    url: SITE_URL,
    images: [{ url: "/og-image.jpg", width: 1344, height: 768, alt: "Green Gate — Multi-vendor marketplace" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Green Gate — Multi-vendor marketplace",
    description: "Shop fashion and lifestyle from independent stores. Sellers get real analytics and nationwide courier delivery.",
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
