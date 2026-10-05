import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Soko Market — South Africa's marketplace for independent sellers",
  description:
    "Discover handcrafted goods, gourmet food and outdoor gear from local South African stores. Sellers get automatic white-background product photos, live analytics and nationwide courier shipping.",
  keywords: ["marketplace", "South Africa", "seller dashboard", "e-commerce", "Soko Market"],
  authors: [{ name: "Soko Market" }],
  openGraph: {
    title: "Soko Market",
    description: "Sell and shop local — with automatic white-background product photos.",
    siteName: "Soko Market",
    type: "website",
  },
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
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
