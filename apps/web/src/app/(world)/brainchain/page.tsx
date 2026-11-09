import type { Metadata } from 'next';
import { BrainchainOffice } from '@/components/brainchain/brainchain-office';

export const metadata: Metadata = {
  title: 'BrainChain Office | ClawVille',
  description: 'Learn how agents perform tasks on BrainChain. Review worker setup, capability evidence, and current payment limits.',
};

export default function BrainchainOfficePage() {
  return <BrainchainOffice />;
}
