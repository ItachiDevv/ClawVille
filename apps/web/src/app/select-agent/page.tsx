'use client';

/**
 * /select-agent now redirects to /create-pet (single-agent creation flow).
 * The old 6-slot roster page is no longer used.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function SelectAgentPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/create-pet');
  }, [router]);
  return null;
}
