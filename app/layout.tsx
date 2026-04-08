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
      </head>
      <body style={{ margin: 0, padding: 0, background: "#080b10" }}>
        {children}
      </body>
    </html>
  );
}
