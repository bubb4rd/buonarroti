import type { Metadata, Viewport } from "next";
import { Newsreader } from "next/font/google";
import "./globals.css";
import { AppSidebar } from "@/components/AppSidebar";
import GlobalModals from "@/components/GlobalModals";
import KieBanner from "@/components/KieBanner";
import UpdateBanner from "@/components/UpdateBanner";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Mark } from "@/components/brand/Mark";
import { cookies } from "next/headers";
import { DragDropGuard } from "@/components/DragDropGuard";
import { THEME_BOOT_SCRIPT } from "@/lib/theme";

const newsreader = Newsreader({
  variable: "--font-newsreader",
  subsets: ["latin"],
  style: ["normal", "italic"],
  axes: ["opsz"],
  display: "swap",
});

/**
 * Desktop shell detection, before first paint. The Tauri shell opens the first
 * page with `?desktop=1` and injects `__TAURI_INTERNALS__`; the flag is kept in
 * sessionStorage so client navigations keep it. Desktop gets the overlay title
 * bar inset (`--titlebar-h`) for the macOS traffic lights.
 */
const DESKTOP_BOOT_SCRIPT = `(function(){try{var d=document.documentElement,s=window.sessionStorage;if(window.__TAURI_INTERNALS__||/[?&]desktop=1\\b/.test(location.search)||s.getItem("buonarroti-desktop")==="1"){s.setItem("buonarroti-desktop","1");d.dataset.desktop="1";d.style.setProperty("--titlebar-h","28px");}}catch(e){}})();`;

export const metadata: Metadata = {
  title: "Buonarroti",
  description: "Make beautiful images and film from your words.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f2eb" },
    { media: "(prefers-color-scheme: dark)", color: "#161513" },
  ],
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const sidebarOpen = cookieStore.get("sidebar_state")?.value !== "false";

  return (
    <html
      lang="en"
      data-theme="paper"
      className={`${newsreader.variable} antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: DESKTOP_BOOT_SCRIPT }} />
      </head>
      <body className="bg-paper-sunk text-ink h-full overflow-hidden">
        {/* Window-drag strip across the exposed ground above the content sheet (desktop only; 0px tall on the web). */}
        <div
          aria-hidden
          data-tauri-drag-region
          className="titlebar-drag fixed inset-x-0 top-0 h-[var(--titlebar-h)]"
        />
        <TooltipProvider>
          <SidebarProvider defaultOpen={sidebarOpen} className="h-full min-h-0">
            <AppSidebar />
            {/* The content sheet. When the sidebar collapses on desktop, it drops below the traffic lights. */}
            <SidebarInset className="flex flex-col min-h-0 min-w-0 bg-paper overflow-hidden md:my-2 md:mr-2 md:rounded-[var(--radius-lg)] md:shadow-[var(--shadow-sm)] md:peer-data-[state=collapsed]:mt-[calc(var(--titlebar-h)+0.5rem)] transition-[margin] duration-200 ease-[var(--ease-out)]">
              <div className="md:hidden flex items-center gap-2 h-11 px-2 pt-[var(--titlebar-h)] box-content border-b border-rule shrink-0">
                <SidebarTrigger className="text-ink-3 hover:text-ink" />
                <Mark className="size-5 text-ink" />
              </div>
              <div className="flex flex-col gap-2 px-3 pt-3 shrink-0 empty:hidden">
                <KieBanner />
                <UpdateBanner />
              </div>
              <DragDropGuard />
              {children}
            </SidebarInset>
          </SidebarProvider>
        </TooltipProvider>
        <GlobalModals />
      </body>
    </html>
  );
}
