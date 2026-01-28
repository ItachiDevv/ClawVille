import type { Metadata } from 'next';
import localFont from 'next/font/local';
import './globals.css';
import { Providers } from './providers';

const elizapet = localFont({
  src: '../../public/fonts/elizapet.ttf',
  variable: '--font-elizapet',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'ElizaPets - Your AI Pet Adventure',
  description: 'Create your ElizaPet and explore Neopia Central!',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${elizapet.variable} font-elizapet antialiased`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
