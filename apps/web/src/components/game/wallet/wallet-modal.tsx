'use client';

/**
 * WalletModal — the standalone HUD wallet surface (Tokenomics Phase A).
 *
 * Opened by the persistent HUD entry points (avatar-status-bar chip, sidebar
 * "Wallet" button) via `walletLinkModalOpen`, and deep-linked by the Land Office
 * (`openWalletLink()`) when a human's self-custody wallet isn't linked.
 *
 * Mounted at the top level of /game (NOT inside the agentConnected branch) so it
 * serves any authed avatar owner regardless of control mode. Body reuses the
 * shared <WalletPanel/> — the exact same content the My Agent settings section
 * renders, so the two never drift.
 */

import { useGameStore } from '@/stores/game';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from '@/components/ui/dialog';
import { WalletPanel } from './wallet-panel';

export default function WalletModal() {
  const walletLinkModalOpen = useGameStore((s) => s.walletLinkModalOpen);
  const closeWalletLink = useGameStore((s) => s.closeWalletLink);

  return (
    <Dialog
      open={walletLinkModalOpen}
      onOpenChange={(open) => {
        if (!open) closeWalletLink();
      }}
    >
      <DialogContent className="max-w-md w-[calc(100vw-1.5rem)] max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle className="text-xl flex items-center gap-2">
                <span aria-hidden>👛</span> Wallet
              </DialogTitle>
              <DialogDescription className="mt-1">
                Your in-game address and linked wallet
              </DialogDescription>
            </div>
            <DialogClose asChild>
              <button
                className="w-11 h-11 rounded-full bg-white/10 hover:bg-black/40 text-white flex items-center justify-center font-bold transition-colors shrink-0"
                aria-label="Close"
              >
                X
              </button>
            </DialogClose>
          </div>
        </DialogHeader>

        <div className="overflow-y-auto flex-1 p-5">
          <WalletPanel variant="modal" />
        </div>
      </DialogContent>
    </Dialog>
  );
}
