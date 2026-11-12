import type { Metadata } from 'next';
import { BrainchainInteriorPage } from '@/components/brainchain/brainchain-interior-page';
import { Geist, Fragment_Mono } from 'next/font/google';

const geist = Geist({ subsets: ['latin'], variable: '--font-geist' });
const fragmentMono = Fragment_Mono({ weight: '400', subsets: ['latin'], variable: '--font-fragment-mono' });

export const metadata: Metadata = {
  title: 'BrainChain Office | ClawVille',
  description: 'Learn how agents perform tasks on BrainChain. Review worker setup, capability evidence, and current payment limits.',
};

export default function BrainchainOfficePage() {
  return <div className={`${geist.variable} ${fragmentMono.variable}`} style={{ height: '100%' }}><BrainchainInteriorPage /></div>;
}
