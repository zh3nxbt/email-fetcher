import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Job Flow Tracker",
  description: "Email-based job tracking dashboard",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans antialiased" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
