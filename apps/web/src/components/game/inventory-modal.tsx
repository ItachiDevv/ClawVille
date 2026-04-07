'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useGameStore } from '@/stores/game';

export default function InventoryModal() {
  const { inventoryOpen, closeInventory, addToast } = useGameStore();
  const queryClient = useQueryClient();
  const [learningId, setLearningId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['inventory'],
    queryFn: () => api.getInventory(),
    enabled: inventoryOpen,
  });

  const learnMutation = useMutation({
    mutationFn: (bookId: string) => api.learnBook(bookId),
    onSuccess: (res) => {
      addToast('📖', `${res.learnedBook} — learned ${res.newKnowledgeCount} new topics!`);
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      queryClient.invalidateQueries({ queryKey: ['avatar'] });
      setLearningId(null);
    },
    onError: (err: Error) => {
      addToast('❌', err.message);
      setLearningId(null);
    },
  });

  if (!inventoryOpen) return null;

  const items = data?.inventory ?? [];

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-white/50 backdrop-blur-sm">
      <div className="legacytheme-panel w-full max-w-md mx-4 max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-white font-bold text-lg">Inventory</h2>
          <button
            onClick={closeInventory}
            className="w-7 h-7 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/10 text-white font-bold text-sm transition-colors"
          >
            X
          </button>
        </div>

        {/* Items list */}
        <div className="flex-1 overflow-y-auto space-y-2">
          {isLoading ? (
            <p className="text-white/50 text-sm text-center py-8">Loading inventory...</p>
          ) : items.length === 0 ? (
            <p className="text-white/50 text-sm text-center py-8">
              Your inventory is empty. Visit a shop to buy items!
            </p>
          ) : (
            items.map((item) => {
              const isLearning = learningId === item.itemId;
              return (
                <div
                  key={item.id}
                  className="flex items-start gap-3 p-3 rounded-lg bg-white/50 border border-white/10"
                >
                  <span className="text-2xl">{item.icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-black text-sm">{item.name}</span>
                      {item.quantity > 1 && (
                        <span className="text-xs text-white/50">x{item.quantity}</span>
                      )}
                    </div>
                    <p className="text-white/60 text-xs mt-0.5 line-clamp-2">{item.description}</p>
                  </div>
                  {item.isBook && (
                    <button
                      onClick={() => {
                        setLearningId(item.itemId);
                        learnMutation.mutate(item.itemId);
                      }}
                      disabled={isLearning}
                      className="text-xs font-bold px-3 py-1 rounded bg-blue-500 hover:bg-blue-400 disabled:opacity-40 text-white transition-colors whitespace-nowrap"
                    >
                      {isLearning ? '...' : 'Read to Avatar'}
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
