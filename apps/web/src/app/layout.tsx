import type { Metadata } from 'next';
import { Orbitron, Oxanium, Space_Mono, Fraunces } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';
import { SWRegister } from '@/components/sw-register';

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

// Fraunces — variable serif used for bio-luminescent NPC + building labels.
// optical-size axis (opsz 9..144) + weight (300..800) loaded; subset latin only.
// display:swap is used so labels render in the fallback serif stack rather than
// staying invisible permanently on slow networks (display:optional risk).
const fraunces = Fraunces({
  subsets: ['latin'],
  axes: ['opsz'],
  variable: '--font-fraunces',
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
      <body className={`${orbitron.variable} ${oxanium.variable} ${spaceMono.variable} ${fraunces.variable} font-oxanium antialiased`}>
        <SWRegister />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
