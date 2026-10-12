import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tally — Your money, in view",
  description: "A private, self-hosted finance tracker.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Tally" },
  icons: { apple: [{ url: "/apple-touch-icon.png?v=2", sizes: "180x180", type: "image/png" }] },
  other: { "apple-mobile-web-app-capable": "yes" },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, maximumScale: 1, userScalable: false, viewportFit: "cover", themeColor: "#f5f6f2" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
