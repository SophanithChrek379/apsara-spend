import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Apsara Spend",
  description: "Personal expense tracker — KHR & USD, built for Cambodia.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Apsara Spend",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",        // Safe-area support for iPhone notch / Dynamic Island
  themeColor: "#080b10",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        {/* iOS PWA home-screen icon */}
        <link rel="apple-touch-icon" href="/icon-192.png" />

        {/* E1 — Font preconnect: establishes early connection to Google Fonts
            so the browser starts the DNS + TLS handshake before the CSS is
            parsed. Prevents a waterfall delay on first load.               */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />

        {/* E1 — Font stylesheet with display=swap */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Open+Sans:wght@400;500;600&family=Poppins:wght@600;700;800&display=swap"
        />
      </head>
      <body style={{ margin: 0, padding: 0, background: "#080b10" }}>
        {children}
      </body>
    </html>
  );
}
