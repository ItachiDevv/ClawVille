'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { CoveClaimToast } from '@/components/cove/CoveClaimToast';
import { IdentityTransitionWatcher } from '@/components/identity-transition-watcher';

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000,
            retry: 1,
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <CoveClaimToast />
      {/* Auth-transition belt: sweeps identity-bearing client state when the
          resolved ['auth-me'] identity changes (silent expiry, account
          switch). See identity-transition-watcher.tsx. */}
      <IdentityTransitionWatcher />
    </QueryClientProvider>
  );
}
