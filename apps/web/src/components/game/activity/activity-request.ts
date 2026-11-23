const API_BASE = process.env.NEXT_PUBLIC_API_URL || '';

/** Works without AbortSignal.any/timeout on older fallback browsers. */
export async function activityRequest<T>(path: string, init: RequestInit = {}, callerSignal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 8000);
  if (callerSignal?.aborted) controller.abort();
  callerSignal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(`${API_BASE}${path}`, { ...init, credentials: 'include', signal: controller.signal });
    const body: unknown = await response.json();
    if (!response.ok) {
      const row = body && typeof body === 'object' ? body as Record<string, unknown> : {};
      throw new Error(typeof row.message === 'string' ? row.message : typeof row.error === 'string' ? row.error : 'Activity request failed. Retry or switch to 3D.');
    }
    return body as T;
  } catch (error) {
    if (timedOut) throw new Error('Activity request timed out. Retry or switch to 3D.');
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', abort);
  }
}
