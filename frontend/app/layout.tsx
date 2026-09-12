import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CodeCortex — Living Codebase Knowledge Graph & AI Multi-Agent System",
  description: "Connect your GitHub repository to generate a living graph, vector embeddings, and verified multi-agent reasoning.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-background text-slate-100 antialiased selection:bg-primary-500 selection:text-white min-h-screen flex flex-col">
        {children}
      </body>
    </html>
  );
}
