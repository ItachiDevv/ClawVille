'use client';

/**
 * The Studios video, character-shot and recast forms (MCP hub phase 3 web).
 * Each one builds the request body for its route (the server schemas in
 * `apps/api/src/services/vendors/studios-operations.ts`) and sends it through
 * the shared `useStudiosRequest` flow of the Studios card. Menu values (model,
 * style and preset ids, operation names) come from Studios: they render as
 * plain text only. A preset never shows or plays an example video.
 * Input images are the avatar's own stored images, sent as absolute API URLs
 * (`api.mediaInputUrl`), the only form the server accepts besides Studios URLs.
 */

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type StudiosMediaModel, type StudiosRecastPreset, type StudiosStoredMedia } from '@/lib/api';
import { centsToUsdText } from '@/lib/usd-cents';
import { useHumanSpendPolicy } from './spending-card';
import { IMAGES_QUERY, StudiosRequestResult, submitLabel, type StudiosPayMode, type StudiosRequestState } from './studios-card';

const MENU_STALE_MS = 10 * 60_000;
const VIDEO_RESOLUTIONS = ['480p', '720p', '768p', '1080p'];
const RECAST_RESOLUTIONS = ['480p', '720p', '1080p'];
export const CHARACTER_SHOTS = [
  { id: 'sheet', label: 'Character sheet' },
  { id: 'headshot', label: 'Headshot' },
  { id: 'full_body', label: 'Full body' },
] as const;

function useMenu<M extends Parameters<typeof api.studiosOptions>[0]>(menu: M) {
  const { signedIn } = useHumanSpendPolicy();
  return useQuery({
    queryKey: ['studios-menu', menu],
    queryFn: () => api.studiosOptions(menu),
    enabled: signedIn,
    retry: false,
    staleTime: MENU_STALE_MS,
    refetchOnWindowFocus: false,
  });
}

/** The avatar's stored images (not videos), newest first, for the image pickers. */
export function storedImages(media: StudiosStoredMedia[] | undefined): StudiosStoredMedia[] {
  return (media ?? []).filter((m) => m.mimeType.startsWith('image/'));
}

function useStoredImages() {
  const { signedIn } = useHumanSpendPolicy();
  const query = useQuery({ queryKey: IMAGES_QUERY, queryFn: api.studiosImages, enabled: signedIn, retry: false });
  return storedImages(query.data?.images);
}

/** A short plain label for a stored image in a picker. */
export function storedImageLabel(item: StudiosStoredMedia): string {
  const day = item.createdAt.slice(0, 10);
  const text = item.prompt.trim().replace(/\s+/g, ' ');
  return `${text.length > 40 ? `${text.slice(0, 40)}...` : text || 'Image'} (${day})`;
}

/** A menu token such as "text_to_video" as words. */
export function tokenWords(token: string): string {
  return token.replace(/[_-]+/g, ' ');
}

const selectClass = 'w-full min-h-[44px] rounded-md bg-black/40 border border-white/15 px-2 text-sm text-white';
const textClass = 'w-full rounded-md bg-black/40 border border-white/15 p-2 text-sm text-white';
const submitClass = 'w-full min-h-[44px] rounded-md bg-violet-500 hover:bg-violet-400 disabled:opacity-50 text-sm font-bold text-white';

function ImagePicker({ label, value, onChange, images, optional }: {
  label: string;
  value: string;
  onChange: (mediaPath: string) => void;
  images: StudiosStoredMedia[];
  optional: boolean;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-white/80">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={selectClass}>
        <option value="">{optional ? 'No image' : 'Choose one of your images'}</option>
        {images.map((item) => <option key={item.id} value={item.mediaPath}>{storedImageLabel(item)}</option>)}
      </select>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

/** The video models of the menu, with only the option values the route accepts. */
export function videoModels(models: StudiosMediaModel[] | undefined): StudiosMediaModel[] {
  return (models ?? []).filter((m) => m.kind === 'video').map((m) => ({
    ...m,
    resolutions: (m.resolutions ?? []).filter((r) => VIDEO_RESOLUTIONS.includes(r)),
    aspectRatios: (m.aspectRatios ?? []).filter((a) => /^\d{1,2}:\d{1,2}$/.test(a)),
  }));
}

/** The whole-second lengths the model takes (1 to 30). */
export function durationChoices(range: StudiosMediaModel['durationSeconds']): number[] {
  if (!range) return [];
  const min = Math.max(1, Math.ceil(range.min ?? 1));
  const max = Math.min(30, Math.floor(range.max ?? min));
  const step = Math.max(1, Math.round(range.step ?? 1));
  const out: number[] = [];
  for (let s = min; s <= max && out.length < 30; s += step) out.push(s);
  return out;
}

/** The price lines Studios gives for a model, as plain text. */
export function modelPriceLines(model: StudiosMediaModel | undefined): string[] {
  if (!model) return [];
  return Object.entries(model.operations).flatMap(([name, op]) => {
    const price = op.usdPerUnit ?? op.listUsdPerUnit;
    return price === undefined ? [] : [`${tokenWords(name)}: $${price.toFixed(3)} per unit${op.audio ? ' (sound possible)' : ''}`];
  });
}

export interface VideoInput {
  prompt: string;
  model: string;
  durationSeconds: number | null;
  resolution: string;
  aspectRatio: string;
  audio: boolean;
  audioOffered: boolean;
  imagePath: string;
}

/** The POST /videos body: only the fields the human set. */
export function buildVideoBody(input: VideoInput, toUrl: (mediaPath: string) => string): Record<string, unknown> {
  const body: Record<string, unknown> = { prompt: input.prompt.trim() };
  if (input.model) body.model = input.model;
  if (input.durationSeconds !== null) body.durationSeconds = input.durationSeconds;
  if (input.resolution) body.resolution = input.resolution;
  if (input.aspectRatio) body.aspectRatio = input.aspectRatio;
  if (input.audioOffered) body.audio = input.audio;
  if (input.imagePath) body.imageUrl = toUrl(input.imagePath);
  return body;
}

const DEFAULT_VIDEO_MODEL = 'minimax-h3-max-turbo';

export function VideoForm({ state, mode, perCallCapUsdCents }: { state: StudiosRequestState; mode: StudiosPayMode; perCallCapUsdCents: number | null }) {
  const menu = useMenu('media-models');
  const models = useMemo(() => videoModels(menu.data?.models), [menu.data]);
  const images = useStoredImages();
  const [prompt, setPrompt] = useState('');
  const [modelId, setModelId] = useState('');
  const [duration, setDuration] = useState<number | null>(null);
  const [resolution, setResolution] = useState('');
  const [aspectRatio, setAspectRatio] = useState('');
  const [audio, setAudio] = useState(false);
  const [imagePath, setImagePath] = useState('');

  useEffect(() => {
    if (modelId || models.length === 0) return;
    setModelId(models.some((m) => m.id === DEFAULT_VIDEO_MODEL) ? DEFAULT_VIDEO_MODEL : models[0]!.id);
  }, [models, modelId]);
  const model = models.find((m) => m.id === modelId);
  const durations = durationChoices(model?.durationSeconds);
  const audioOffered = Object.values(model?.operations ?? {}).some((op) => op.audio === true);
  // A new model resets the options it may not take.
  useEffect(() => {
    setDuration(model?.durationSeconds?.default ?? null);
    setResolution('');
    setAspectRatio('');
    setAudio(false);
  }, [model]);

  const body = buildVideoBody({
    prompt,
    model: modelId,
    durationSeconds: duration !== null && durations.includes(duration) ? duration : null,
    resolution,
    aspectRatio,
    audio,
    audioOffered,
    imagePath,
  }, api.mediaInputUrl);
  const ready = prompt.trim().length > 0;
  const blocked = ready && state.isBlocked(body);

  return (
    <>
      <label className="block space-y-1">
        <span className="text-xs text-white/80">Describe the video</span>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value.slice(0, 1000))} rows={3} className={textClass} placeholder="A crab dancing on the beach at sunset" />
      </label>
      {menu.isError ? (
        <p className="text-xs text-red-300">The Studios model list did not load. The cheapest model is used.</p>
      ) : (
        <label className="block space-y-1">
          <span className="text-xs text-white/80">Model</span>
          <select value={modelId} onChange={(e) => setModelId(e.target.value)} className={selectClass} disabled={models.length === 0}>
            {models.length === 0 && <option value="">Loading...</option>}
            {models.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
          </select>
        </label>
      )}
      {durations.length > 0 && (
        <label className="block space-y-1">
          <span className="text-xs text-white/80">Length (seconds)</span>
          <select value={duration ?? ''} onChange={(e) => setDuration(e.target.value ? Number(e.target.value) : null)} className={selectClass}>
            <option value="">Studios default</option>
            {durations.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      )}
      {(model?.resolutions?.length ?? 0) > 0 && (
        <label className="block space-y-1">
          <span className="text-xs text-white/80">Resolution</span>
          <select value={resolution} onChange={(e) => setResolution(e.target.value)} className={selectClass}>
            <option value="">Studios default</option>
            {model!.resolutions!.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
      )}
      {(model?.aspectRatios?.length ?? 0) > 0 && (
        <label className="block space-y-1">
          <span className="text-xs text-white/80">Aspect ratio</span>
          <select value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)} className={selectClass}>
            <option value="">Studios default</option>
            {model!.aspectRatios!.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
      )}
      {audioOffered && (
        <label className="flex items-center gap-3 min-h-[44px] text-xs text-white/85">
          <input type="checkbox" className="h-5 w-5 shrink-0" checked={audio} onChange={(e) => setAudio(e.target.checked)} />
          With sound
        </label>
      )}
      <ImagePicker label="Start image (optional, from your images)" value={imagePath} onChange={setImagePath} images={images} optional />
      <div className="text-xs text-white/60 leading-relaxed space-y-0.5">
        {modelPriceLines(model).map((line) => <p key={line}>{line}</p>)}
        {mode === 'wallet' ? (
          <p>
            Your agent wallet pays the Studios price. Your per-call cap is{' '}
            {perCallCapUsdCents === null ? 'not set, so nothing can be paid' : `$${centsToUsdText(perCallCapUsdCents)}`}. A video above it is
            refused and nothing is paid. The wallet never pays more than $3.00 for one video.
          </p>
        ) : (
          <p>Studios bills your Studios credits.</p>
        )}
      </div>
      <button type="button" onClick={() => state.submit(body)} disabled={state.sending || state.open || !ready || blocked} className={submitClass}>
        {submitLabel(state, blocked, 'Make video')}
      </button>
      <StudiosRequestResult state={state} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Character shots
// ---------------------------------------------------------------------------

export interface CharacterInput {
  shots: string[];
  prompt: string;
  random: boolean;
  style: string;
  imagePath: string;
}

/** The POST /characters body, or null when nothing describes the character. */
export function buildCharacterBody(input: CharacterInput, toUrl: (mediaPath: string) => string): Record<string, unknown> | null {
  const prompt = input.prompt.trim();
  if (!prompt && !input.random && !input.imagePath) return null;
  const body: Record<string, unknown> = {};
  const shots = CHARACTER_SHOTS.map((s) => s.id).filter((id) => input.shots.includes(id));
  if (shots.length > 0) body.shots = shots;
  if (prompt) body.prompt = prompt;
  if (input.random) body.random = true;
  if (input.style) body.style = input.style;
  if (input.imagePath) body.imageUrl = toUrl(input.imagePath);
  return body;
}

export function CharacterForm({ state }: { state: StudiosRequestState }) {
  const styles = useMenu('image-styles');
  const images = useStoredImages();
  const [shots, setShots] = useState<string[]>(['sheet']);
  const [prompt, setPrompt] = useState('');
  const [random, setRandom] = useState(false);
  const [style, setStyle] = useState('');
  const [imagePath, setImagePath] = useState('');
  const body = buildCharacterBody({ shots, prompt, random, style, imagePath }, api.mediaInputUrl);
  const blocked = body !== null && state.isBlocked(body);

  return (
    <>
      <fieldset className="space-y-1">
        <legend className="text-xs text-white/80">Shots</legend>
        {CHARACTER_SHOTS.map((shot) => (
          <label key={shot.id} className="flex items-center gap-3 min-h-[44px] text-xs text-white/85">
            <input
              type="checkbox"
              className="h-5 w-5 shrink-0"
              checked={shots.includes(shot.id)}
              onChange={(e) => setShots((current) => (e.target.checked ? [...current, shot.id] : current.filter((s) => s !== shot.id)))}
            />
            {shot.label}
          </label>
        ))}
      </fieldset>
      <label className="block space-y-1">
        <span className="text-xs text-white/80">Describe the character (optional)</span>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value.slice(0, 1000))} rows={3} className={textClass} placeholder="A brave crab knight with a shell helmet" />
      </label>
      <label className="flex items-center gap-3 min-h-[44px] text-xs text-white/85">
        <input type="checkbox" className="h-5 w-5 shrink-0" checked={random} onChange={(e) => setRandom(e.target.checked)} />
        Let Studios pick at random
      </label>
      <label className="block space-y-1">
        <span className="text-xs text-white/80">Style (optional)</span>
        <select value={style} onChange={(e) => setStyle(e.target.value)} className={selectClass}>
          <option value="">No style</option>
          {(styles.data?.styles ?? []).map((s) => <option key={s.id} value={s.id}>{s.id}{s.type === 'template' ? ' (template)' : ''}</option>)}
        </select>
      </label>
      <ImagePicker label="Image of the character (optional, from your images)" value={imagePath} onChange={setImagePath} images={images} optional />
      <p className="text-xs text-white/60 leading-relaxed">
        Studios bills your Studios credits. The Studios menu gives no price for character shots; Studios shows it in your account.
      </p>
      {body === null && <p className="text-xs text-white/60">Write a text, tick &quot;pick at random&quot;, or choose an image.</p>}
      <button type="button" onClick={() => body && state.submit(body)} disabled={state.sending || state.open || body === null || blocked} className={submitClass}>
        {submitLabel(state, blocked, 'Make character shots')}
      </button>
      <StudiosRequestResult state={state} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Recast
// ---------------------------------------------------------------------------

/** How many photos the preset needs: one per performer, 1 to 4. */
export function performerCount(preset: StudiosRecastPreset | undefined): number {
  const n = preset?.performers ?? preset?.minImages ?? 1;
  return Math.min(4, Math.max(1, Math.round(n)));
}

/** The resolutions the preset offers that the route accepts. */
export function presetResolutions(preset: StudiosRecastPreset | undefined): Array<{ id: string; priceUsd: number }> {
  return (preset?.resolutions ?? []).filter((r) => RECAST_RESOLUTIONS.includes(r.id));
}

/** The price of the preset at a resolution ('' = the preset default), or null when the menu gives none. */
export function recastPriceUsd(preset: StudiosRecastPreset | undefined, resolution: string): number | null {
  if (!preset) return null;
  const id = resolution || preset.defaultResolution || '';
  const row = presetResolutions(preset).find((r) => r.id === id);
  return row?.priceUsd ?? preset.priceUsd ?? null;
}

/** The plain label of a preset in the list (id, price, shape, performers). */
export function presetLabel(preset: StudiosRecastPreset): string {
  const parts = [preset.id];
  if (preset.priceUsd !== undefined) parts.push(`$${preset.priceUsd.toFixed(2)}`);
  if (preset.shape) parts.push(preset.shape);
  const n = performerCount(preset);
  parts.push(n === 1 ? '1 performer' : `${n} performers`);
  if (preset.seconds !== undefined) parts.push(`${preset.seconds} s`);
  return parts.join(', ');
}

/** The POST /recasts body, or null while a photo is missing. */
export function buildRecastBody(
  input: { preset: string; resolution: string; direction: string; photos: string[]; needed: number },
  toUrl: (mediaPath: string) => string,
): Record<string, unknown> | null {
  if (!input.preset) return null;
  const photos = input.photos.slice(0, input.needed);
  if (photos.length < input.needed || photos.some((p) => !p)) return null;
  const body: Record<string, unknown> = { preset: input.preset, imageUrls: photos.map(toUrl) };
  if (input.resolution) body.resolution = input.resolution;
  const direction = input.direction.trim();
  if (direction) body.direction = direction;
  return body;
}

export function RecastForm({ state }: { state: StudiosRequestState }) {
  const menu = useMenu('recast-presets');
  const presets = menu.data?.presets ?? [];
  const images = useStoredImages();
  const [presetId, setPresetId] = useState('');
  const [resolution, setResolution] = useState('');
  const [direction, setDirection] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const preset = presets.find((p) => p.id === presetId);
  const needed = performerCount(preset);
  useEffect(() => {
    setResolution('');
    setPhotos([]);
  }, [presetId]);

  const body = buildRecastBody({ preset: presetId, resolution, direction, photos, needed }, api.mediaInputUrl);
  const blocked = body !== null && state.isBlocked(body);
  const price = recastPriceUsd(preset, resolution);

  return (
    <>
      {menu.isError ? (
        <p className="text-xs text-red-300">The Studios preset list did not load. Try again later.</p>
      ) : (
        <label className="block space-y-1">
          <span className="text-xs text-white/80">Preset</span>
          <select value={presetId} onChange={(e) => setPresetId(e.target.value)} className={selectClass}>
            <option value="">{menu.isLoading ? 'Loading...' : 'Choose a preset'}</option>
            {presets.map((p) => <option key={p.id} value={p.id}>{presetLabel(p)}</option>)}
          </select>
        </label>
      )}
      {preset && presetResolutions(preset).length > 0 && (
        <label className="block space-y-1">
          <span className="text-xs text-white/80">Resolution</span>
          <select value={resolution} onChange={(e) => setResolution(e.target.value)} className={selectClass}>
            <option value="">Preset default{preset.defaultResolution ? ` (${preset.defaultResolution})` : ''}</option>
            {presetResolutions(preset).map((r) => <option key={r.id} value={r.id}>{r.id}: ${r.priceUsd.toFixed(2)}</option>)}
          </select>
        </label>
      )}
      {preset && Array.from({ length: needed }, (_, i) => (
        <ImagePicker
          key={i}
          label={needed === 1 ? 'Photo of the performer (from your images)' : `Photo of performer ${i + 1} (from your images)`}
          value={photos[i] ?? ''}
          onChange={(path) => setPhotos((current) => {
            const next = [...current];
            next[i] = path;
            return next;
          })}
          images={images}
          optional={false}
        />
      ))}
      {preset && images.length === 0 && (
        <p className="text-xs text-amber-200">You have no stored image yet. Make an image first (Image, above).</p>
      )}
      <label className="block space-y-1">
        <span className="text-xs text-white/80">Direction (optional)</span>
        <input value={direction} onChange={(e) => setDirection(e.target.value.slice(0, 500))} className={`${selectClass} min-w-0`} placeholder="Smile at the end" />
      </label>
      {preset && (
        <p className="text-xs text-white/80" data-testid="recast-price">
          {price === null ? 'The Studios menu gives no price for this preset.' : `Price: $${price.toFixed(2)} of your Studios credits.`}
        </p>
      )}
      <button type="button" onClick={() => body && state.submit(body)} disabled={state.sending || state.open || body === null || blocked} className={submitClass}>
        {submitLabel(state, blocked, 'Make recast clip')}
      </button>
      <StudiosRequestResult state={state} />
    </>
  );
}
