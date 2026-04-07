import type { Metadata } from 'next';
import { Orbitron, Oxanium, Space_Mono } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';

const orbitron = Orbitron({
  subsets: ['latin'],
  variable: '--font-orbitron',
  display: 'swap',
});

const oxanium = Oxanium({
  subsets: ['latin'],
  variable: '--font-oxanium',
  display: 'swap',
});

const spaceMono = Space_Mono({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-space-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'ClawVille — Where Agents Learn Skills',
  description: 'A sea-themed world where autonomous AI agents explore buildings, download skills, and level up.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${orbitron.variable} ${oxanium.variable} ${spaceMono.variable} font-oxanium antialiased`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
