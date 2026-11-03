import type { Metadata } from "next";
import "./globals.css";
import { Toaster } from "sonner";
export const metadata: Metadata = { title: "LabLock Examination System", description: "Institutional AI-proctored examination terminal" };
export default function RootLayout({children}:{children:React.ReactNode}) { return <html lang="en"><body>{children}<Toaster richColors position="top-right" /></body></html>; }
