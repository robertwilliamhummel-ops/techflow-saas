import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { NEUTRAL_TAB_ICON } from "@/lib/tenant/tabIcon";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "TechFlow",
  description: "TechFlow SaaS",
  // Pages that set no icon of their own, a 404 on a business's domain
  // among them, stay neutral; TechFlow's pages set TechFlow's (G-03).
  icons: { icon: NEUTRAL_TAB_ICON },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={cn("font-sans", inter.variable)}>
      <body className="antialiased">
        {children}
        <Toaster position="bottom-center" richColors closeButton />
      </body>
    </html>
  );
}
