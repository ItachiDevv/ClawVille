// ---------------------------------------------------------------------------
// Cloudflare Worker — ClawVille Meshy webhook receiver
// ---------------------------------------------------------------------------
// Receives Meshy task-status events (POST /), verifies the shared secret,
// logs the payload, and returns 200. Downstream auto-rig is SCAFFOLDED but
// gated OFF (ENABLE_DOWNSTREAM_RIG !== "true").
//
// Meshy webhook registration is DASHBOARD-UI ONLY (no API). After deploying,
// paste the worker URL + the MESHY_WEBHOOK_SECRET value into:
//   Meshy → API → Webhooks → Create Webhook  (Payload URL + Secret).
//
// Meshy does NOT publicly document its signature header/algorithm, so v1 runs
// in NON-STRICT mode: it logs all (non-secret) headers — so we can identify the
// real signature header from the first live delivery — and accepts. Once the
// header is known, flip WEBHOOK_STRICT="true" to hard-reject forged/unsigned
// deliveries. See README.md.
// ---------------------------------------------------------------------------

export interface Env {
  MESHY_WEBHOOK_SECRET?: string; // shared secret, also pasted into the Meshy form
  MESHY_API_KEY?: string; // for the scaffolded downstream rig (option 4)
  WEBHOOK_STRICT?: string; // "true" => require a verified signature
  ENABLE_DOWNSTREAM_RIG?: string; // "true" => auto-submit mesh→rig on SUCCEEDED
}

// Header names webhook providers commonly use to carry the HMAC signature.
const SIG_HEADER_CANDIDATES = [
  "meshy-signature",
  "x-meshy-signature",
  "x-webhook-signature",
  "webhook-signature",
  "x-signature",
  "x-hub-signature-256",
];

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

// verified=true only on a CONFIRMED HMAC-SHA256 match against a known header.
async function verify(
  req: Request,
  rawBody: string,
  secret: string | undefined,
): Promise<{ verified: boolean; detail: string }> {
  if (!secret) return { verified: false, detail: "no secret configured" };
  for (const h of SIG_HEADER_CANDIDATES) {
    const provided = req.headers.get(h);
    if (!provided) continue;
    const expected = await hmacSha256Hex(secret, rawBody);
    // tolerate "sha256=<hex>" style prefixes
    const got = (provided.includes("=") ? provided.split("=").pop()! : provided).trim().toLowerCase();
    if (timingSafeEqual(got, expected)) return { verified: true, detail: `HMAC-SHA256 ok via '${h}'` };
    return { verified: false, detail: `header '${h}' present but MISMATCH` };
  }
  return { verified: false, detail: "no known signature header present" };
}

// FEATURE_GATE: meshy_downstream_rig
// Status: scaffolded stub, gated OFF (ENABLE_DOWNSTREAM_RIG !== "true").
// Metric to graduate: first live mesh gen confirmed arriving via this webhook.
// On enable: POST the SUCCEEDED mesh task to Meshy's rigging endpoint using
//   env.MESHY_API_KEY (payload shape locked from a real delivery first), then
//   animate. Kept a no-op until then so we never fire PAID rig calls before the
//   plumbing is confirmed.
async function maybeTriggerDownstreamRig(env: Env, task: any): Promise<void> {
  const succeeded = String(task?.status ?? "").toUpperCase() === "SUCCEEDED";
  if (!succeeded) return;
  if (env.ENABLE_DOWNSTREAM_RIG !== "true") {
    console.log(`[downstream-rig] GATED OFF — would consider rig for SUCCEEDED task ${task?.id}`);
    return;
  }
  // TODO(option 4): real implementation once a live payload shape is captured.
  //   await fetch("https://api.meshy.ai/openapi/v1/rigging", {
  //     method: "POST",
  //     headers: { Authorization: `Bearer ${env.MESHY_API_KEY}`, "Content-Type": "application/json" },
  //     body: JSON.stringify({ input_task_id: task.id, /* ... */ }),
  //   });
  console.log(`[downstream-rig] ENABLED (stub, not yet implemented) — task ${task?.id}`);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "clawville-meshy-webhook" });
    }
    if (req.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    const rawBody = await req.text();
    const strict = env.WEBHOOK_STRICT === "true";
    const { verified, detail } = await verify(req, rawBody, env.MESHY_WEBHOOK_SECRET);

    // Log non-secret headers so we can identify Meshy's signature scheme from
    // the first real delivery, then lock WEBHOOK_STRICT="true".
    const headerDump: Record<string, string> = {};
    for (const [k, v] of req.headers) {
      if (k.toLowerCase() === "authorization") continue;
      headerDump[k] = v;
    }
    console.log(
      `[meshy-webhook] verify=${verified} (${detail}) strict=${strict} headers=${JSON.stringify(headerDump)}`,
    );

    if (strict && !verified) {
      console.warn("[meshy-webhook] REJECTED (strict mode, unverified)");
      return Response.json({ ok: false, error: "unverified" }, { status: 401 });
    }

    let task: any = null;
    try {
      task = JSON.parse(rawBody);
    } catch {
      console.warn("[meshy-webhook] non-JSON body");
    }
    console.log(
      `[meshy-webhook] task id=${task?.id} status=${task?.status} body=${rawBody.slice(0, 2000)}`,
    );

    try {
      await maybeTriggerDownstreamRig(env, task);
    } catch (e) {
      console.error("[meshy-webhook] downstream error", e);
    }

    // MUST reply < 400 or Meshy treats it as a failed delivery.
    return Response.json({ ok: true });
  },
};
