---
name: feedback-coolify-envvar-encryption
description: "NEVER write to Coolify environment_variables.value via raw DB::update + Crypt::encryptString — the model has a value mutator that re-encrypts via a non-Laravel-default cipher, so raw writes break decryption and kill deploys with `decrypt()` exceptions."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 660f876a-b012-459e-8ed1-977182c0844d
---

Inside the Coolify `coolify` container, **NEVER** write `environment_variables.value` via raw SQL with `\Crypt::encryptString(...)`. Use the Eloquent model: `$row->value = '<plaintext>'; $row->save();` — the model's `setValueAttribute` mutator handles encryption correctly.

**Why:** During the 2026-05-23 prod migration I used `\DB::update("UPDATE environment_variables SET value = ?, ... WHERE ...", [\Crypt::encryptString($plain), ...])` to flip `CORS_ORIGIN` and `NEXT_PUBLIC_API_URL` on the new prod Coolify. The values that landed in the column were Laravel-`Crypt::encryptString`-shaped, but Coolify's `EnvironmentVariable` value accessor uses a different code path (probably `decrypt()` with extended cipher params) and threw `unserialize()` failures during `queue_application_deployment`'s env-resolve step. Both prod redeploys failed with:

```
Illuminate\Encryption\Encrypter.php(195): unserialize()
app/Models/EnvironmentVariable.php(354): decrypt()
```

Forced a DNS rollback to the old box for ~5 min while I fixed it. Re-write via `$row->value = $plain; $row->save();` made the second cutover succeed on first attempt.

**How to apply:** Any tinker payload that mutates Coolify env vars MUST go through the model — even when you have 20+ rows to update, build a `foreach (EnvironmentVariable::where(...)->get() as $row)` loop. Raw SQL is fine for INSPECTION (`DB::select`) but never for value writes. Same rule applies if Coolify ever ships a similar mutator on `PrivateKey::private_key`, `User::password`, or any other encrypted-at-rest column.

Companion to [[project_deploy_infrastructure]] (prod box at 5.78.129.176 / staging at 87.99.142.34).
