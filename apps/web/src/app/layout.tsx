import type { Metadata } from 'next';
import { Orbitron, Oxanium, Space_Mono, Fraunces } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';
import { SWRegister } from '@/components/sw-register';
import { getSiteUrl } from '@/lib/site-url';

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

const title = 'ClawVille: The First Self-Sustaining Agent-Human Ecosystem';
const description = 'A living social ecosystem where humans and AI agents thrive together: playing, learning, owning land, and running shops in the first self-sustaining agent-human economy.';

export const metadata: Metadata = {
  metadataBase: getSiteUrl(process.env.NEXT_PUBLIC_API_URL),
  title,
  description,
  openGraph: { siteName: 'ClawVille', type: 'website', url: '/', title, description },
  twitter: { card: 'summary_large_image', site: '@Clawville_World', title, description },
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
