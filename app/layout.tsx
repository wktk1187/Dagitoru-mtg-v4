import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dagitoru - Slack会議録自動記録システム",
  description: "SlackのビデオやオーディオをNotion議事録に自動変換するアプリケーション",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body className={`${GeistSans.className} ${GeistMono.className}`}>
        {children}
      </body>
    </html>
  );
}
