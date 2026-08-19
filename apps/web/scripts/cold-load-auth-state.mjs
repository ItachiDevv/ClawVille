// cold-load-auth-state.mjs — mint a probe storage-state fixture for the
// slice-D AUTHENTICATED lane (spec §5 [R2-F13]): logs into the local API and
// writes { cookies: [...] } for cold-load-probe.mjs --storage-state.
//
// The auth_session cookie is HOST-ONLY on localhost (no Domain attribute), so
// it is written with a url entry — CDP Network.setCookie scopes it to the
// host, which covers both web ports (:3010/:3011) fetching the API with
// credentials.
//
// usage: bun cold-load-auth-state.mjs <email> <password> <api-base> <out.json>
//   e.g. bun cold-load-auth-state.mjs landtest1@staging.clawville.test 'PW' \
//          http://localhost:4001 ~/.cold-load-probe-profiles/auth-state.json

const [email, password, apiBase, outPath] = process.argv.slice(2);
if (!email || !password || !apiBase || !outPath) {
  console.error("usage: bun cold-load-auth-state.mjs <email> <password> <api-base> <out.json>");
  process.exit(2);
}

const res = await fetch(`${apiBase}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
});
if (!res.ok) {
  console.error(`[auth-state] login failed: HTTP ${res.status} ${await res.text()}`);
  process.exit(1);
}
const setCookie = res.headers.get("set-cookie") ?? "";
const match = /auth_session=([^;]+)/.exec(setCookie);
if (!match) {
  console.error("[auth-state] no auth_session cookie in login response");
  process.exit(1);
}

// Sanity: the session must resolve an avatar (the boot-actor lane depends on
// it). Fail closed here rather than 12 runs into a batch.
const me = await fetch(`${apiBase}/api/avatars/me`, {
  headers: { Cookie: `auth_session=${match[1]}` },
});
if (!me.ok) {
  console.error(`[auth-state] session cannot fetch avatar: HTTP ${me.status}`);
  process.exit(1);
}
const avatar = (await me.json())?.avatar;
console.log(`[auth-state] ok: ${email} avatar=${avatar?.name} modelKey=${avatar?.modelKey}`);

await Bun.write(
  outPath,
  JSON.stringify(
    {
      mintedAt: new Date().toISOString(),
      email,
      avatarModelKey: avatar?.modelKey ?? null,
      cookies: [
        { name: "auth_session", value: match[1], url: apiBase, path: "/" },
      ],
    },
    null,
    2,
  ),
);
console.log(`[auth-state] wrote ${outPath}`);
