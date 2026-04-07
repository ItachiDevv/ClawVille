import type { Metadata } from 'next';
import localFont from 'next/font/local';
import './globals.css';
import { Providers } from './providers';

const clawville = localFont({
  src: '../../public/fonts/clawville.ttf',
  variable: '--font-clawville',
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
      <body className={`${clawville.variable} font-clawville antialiased`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
