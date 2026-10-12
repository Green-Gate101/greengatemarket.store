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
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "48x48" },
      { url: "/icon.svg", type: "image/svg+xml", sizes: "any" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
    ],
    apple: "/apple-touch-icon.png",
  },
  manifest: "/manifest.webmanifest",
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#16a34a",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased bg-background text-foreground">
        {/* Structured data so search engines show the Green Gate name and logo
            on results for greengatemarket.store (Organization logo + WebSite
            sitename, the two pieces Google reads for brand display). */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@graph": [
                {
                  "@type": "Organization",
                  "@id": `${SITE_URL}/#organization`,
                  name: "Green Gate",
                  url: SITE_URL,
                  slogan: "Soo good you wanna gate keep",
                  logo: {
                    "@type": "ImageObject",
                    url: `${SITE_URL}/icon-512.png`,
                    width: 512,
                    height: 512,
                  },
                  image: `${SITE_URL}/og-image.jpg`,
                },
                {
                  "@type": "WebSite",
                  "@id": `${SITE_URL}/#website`,
                  url: SITE_URL,
                  name: "Green Gate",
                  publisher: { "@id": `${SITE_URL}/#organization` },
                },
              ],
            }),
          }}
        />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
