'use client';

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { useGameStore } from '@/stores/game';
import { useLocationChat } from '@/hooks/use-location-chat';
import { useLocationAgent } from '@/hooks/use-locations';
import { MAP_LOCATIONS } from '@elizapets/shared';

export default function ChatPanel() {
  const { chatOpen, currentLocation, exitBuilding } = useGameStore();
  const { messages, sendMessage, isLoading } = useLocationChat(currentLocation);
  const { data: agent, isLoading: isAgentLoading } = useLocationAgent(currentLocation);

  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const location = MAP_LOCATIONS.find((l) => l.id === currentLocation);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  if (!chatOpen || !currentLocation) return null;

  const handleSend = () => {
    if (!input.trim() || isLoading) return;
    sendMessage(input.trim());
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="chat-panel-enter fixed right-0 top-0 h-full w-96 z-50 flex flex-col bg-black/80 backdrop-blur-sm border-l-2 border-yellow-500/50">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-yellow-600 to-yellow-500 text-black font-bold">
        <span className="flex items-center gap-2">
          {location?.icon} {location?.name ?? 'Unknown'}
        </span>
        <button
          onClick={exitBuilding}
          className="w-8 h-8 flex items-center justify-center rounded-full bg-black/20 hover:bg-black/40 text-white font-bold transition-colors"
          aria-label="Close"
        >
          X
        </button>
      </div>

      {/* Body */}
      {isAgentLoading ? (
        <div className="flex-1 flex items-center justify-center text-yellow-300/70 text-sm">
          Loading...
        </div>
      ) : !agent ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6 text-center">
          <p className="text-yellow-300/80 text-sm">
            No agent has been configured for this location.
          </p>
          <Link
            href={`/locations/${currentLocation}/configure`}
            className="neopets-panel text-black font-bold px-4 py-2 hover:brightness-110 transition-all text-sm"
          >
            Configure Agent
          </Link>
        </div>
      ) : (
        <>
          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {messages.length === 0 && (
              <p className="text-yellow-300/50 text-sm text-center mt-8">
                Start a conversation...
              </p>
            )}
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                    msg.role === 'user'
                      ? 'bg-yellow-500/90 text-black'
                      : 'bg-white/10 text-yellow-100'
                  }`}
                >
                  {msg.content}
                </div>
              </div>
            ))}
            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-white/10 text-yellow-300/70 rounded-lg px-3 py-2 text-sm">
                  <span className="animate-pulse">Thinking...</span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="px-4 py-3 border-t border-yellow-500/20">
            <div className="flex gap-2">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type a message..."
                className="flex-1 bg-white/10 text-white placeholder-white/40 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-yellow-500/50"
                disabled={isLoading}
              />
              <button
                onClick={handleSend}
                disabled={isLoading || !input.trim()}
                className="bg-yellow-500 hover:bg-yellow-400 disabled:opacity-50 text-black font-bold rounded-lg px-4 py-2 text-sm transition-colors"
              >
                Send
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
