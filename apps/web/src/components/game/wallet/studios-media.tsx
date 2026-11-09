'use client';

/**
 * The avatar's stored Studios media (MCP hub phase 3 web): images and videos
 * that the human or the agent made, from GET /api/vendors/studios/images.
 * A video uses `<video controls preload="none">` and never plays by itself.
 * Delete: POST /api/media/<id>/delete-challenge, the linked wallet signs, then
 * DELETE /api/media/<id> with `{ proof }` (a session cookie alone never deletes).
 *
 * "My Studios media" (Studios sign-in only): the human's Studios My Media
 * from GET /api/vendors/studios/signin/media, id, kind, state and date only
 * (the API carries no Studios text, by design). It loads on a button press,
 * because the sign-in reads share a 12 per minute limit with the agent.
 */

import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type StudiosStoredMedia } from '@/lib/api';
import { signMessageWithSolanaWallet } from '@/lib/solana-wallet';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useHumanSpendPolicy } from './spending-card';
import { IMAGES_QUERY, StudiosMediaView, studiosErrorText } from './studios-card';

/** Delete one stored item: the linked wallet signs the challenge for that item. */
export async function deleteStoredMedia(mediaId: string): Promise<void> {
  const challenge = await api.mediaDeleteChallenge(mediaId);
  const signed = await signMessageWithSolanaWallet(challenge.messageToSign, challenge.walletPubkey);
  await api.deleteMedia(mediaId, { nonce: challenge.nonce, signature: signed.signatureBase58 });
}

export function StudiosMediaGallery() {
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const { signedIn } = useHumanSpendPolicy();
  const query = useQuery({ queryKey: IMAGES_QUERY, queryFn: api.studiosImages, enabled: signedIn, retry: false });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const remove = useMutation({
    mutationFn: deleteStoredMedia,
    onMutate: (id) => setErrors((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: IMAGES_QUERY }),
    onError: (err, id) => {
      setErrors((current) => ({ ...current, [id]: studiosErrorText(err) }));
      queryClient.invalidateQueries({ queryKey: IMAGES_QUERY });
    },
  });
  const items = query.data?.images ?? [];

  return (
    <div className="space-y-2" data-testid="studios-media">
      <p className="text-xs text-white/60 leading-relaxed">
        Yours and your agent&apos;s, newest first. ClawVille keeps at most 50 items and 500 MB. Anyone with the link of an item can see it.
        Your linked wallet signs each delete.
      </p>
      {query.isLoading ? (
        <p className="text-xs text-white/60">Loading...</p>
      ) : query.isError ? (
        <p className="text-xs text-red-300">{studiosErrorText(query.error)}</p>
      ) : items.length === 0 ? (
        <p className="text-xs text-white/60">No media yet.</p>
      ) : (
        <ul className={`grid gap-2 ${isMobile ? 'grid-cols-2' : 'grid-cols-3'}`}>
          {items.map((item: StudiosStoredMedia) => (
            <li key={item.id} className="min-w-0 space-y-1" data-testid="studios-media-item">
              <StudiosMediaView item={{ mediaPath: item.mediaPath, video: item.mimeType.startsWith('video/') }} alt={item.prompt || 'Stored image'} />
              {/* Prompt text may be the agent's: plain text only. */}
              <p className="text-[11px] text-white/60 break-words line-clamp-2">{item.prompt}</p>
              <button
                type="button"
                onClick={() => remove.mutate(item.id)}
                disabled={remove.isPending}
                className="w-full min-h-[44px] rounded-md border border-white/20 text-xs text-white/80 hover:bg-white/10 disabled:opacity-50"
              >
                {remove.isPending && remove.variables === item.id ? 'Approve...' : 'Delete'}
              </button>
              {errors[item.id] && <p className="text-[11px] text-red-300 break-words">{errors[item.id]}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const SIGNIN_MEDIA_PAGE = 24;

export function StudiosSigninMediaList() {
  const { signedIn } = useHumanSpendPolicy();
  const [shown, setShown] = useState(false);
  const query = useInfiniteQuery({
    queryKey: ['studios-signin-media'],
    queryFn: ({ pageParam }) => api.studiosSigninMedia({ limit: SIGNIN_MEDIA_PAGE, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: signedIn && shown,
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];

  if (!shown) {
    return (
      <button
        type="button"
        onClick={() => setShown(true)}
        className="w-full min-h-[44px] rounded-md bg-white/15 hover:bg-white/25 text-sm text-white"
      >
        Show my Studios media
      </button>
    );
  }
  return (
    <div className="space-y-2" data-testid="studios-signin-media">
      <p className="text-xs text-white/60 leading-relaxed">Your Studios My Media. ClawVille shows the id, the kind and the state only.</p>
      {query.isLoading ? (
        <p className="text-xs text-white/60">Loading...</p>
      ) : query.isError ? (
        <p className="text-xs text-red-300">{studiosErrorText(query.error)}</p>
      ) : items.length === 0 ? (
        <p className="text-xs text-white/60">Your Studios My Media is empty.</p>
      ) : (
        <ul className="space-y-1">
          {items.map((item) => (
            <li key={item.id} className="rounded border border-white/10 px-2 py-1 text-xs text-white/80 min-w-0">
              <span className="block font-mono break-all">{item.id}</span>
              <span className="block text-white/55">
                {item.kind === 'video' ? 'Video' : item.kind === 'image' ? 'Image' : 'Unknown kind'}
                {item.state === 'problem' ? ', has a problem' : item.state === 'ready' ? ', ready' : ''}
                {item.createdAt ? `, ${item.createdAt.slice(0, 10)}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      {query.hasNextPage && (
        <button
          type="button"
          onClick={() => query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
          className="w-full min-h-[44px] rounded-md border border-white/20 text-sm text-white/80 hover:bg-white/10 disabled:opacity-50"
        >
          {query.isFetchingNextPage ? 'Loading...' : 'Show more'}
        </button>
      )}
    </div>
  );
}
