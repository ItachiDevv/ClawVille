import type { Metadata } from 'next';
import localFont from 'next/font/local';
import './globals.css';
import { Providers } from './providers';

const legacyapp = localFont({
  src: '../../public/fonts/legacyapp.ttf',
  variable: '--font-legacyapp',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'LegacyApp - Your AI Avatar Adventure',
  description: 'Create your LegacyApp and explore ClawVille!',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${legacyapp.variable} font-legacyapp antialiased`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
