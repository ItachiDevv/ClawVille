/**
 * EIP-8004 agent registration JSON for SAP-registered ClawVille agents
 * (the Metaplex `AgentIdentity` / mpl-agent-014 identity rail).
 *
 *   GET /agents/:sapAgentPda/eip-8004.json
 *
 * This URL shape is LOAD-BEARING and immutable once minted: each agent's
 * MPL Core identity asset carries an `AgentIdentity` external plugin whose
 * `uri` points at exactly `https://api.clawville.world/agents/<sapAgentPda>/eip-8004.json`
 * (attached via the 1DREG registry program `RegisterIdentityV1`, which is
 * the only path the deployed mpl-core accepts for that plugin). Verifiers —
 * Covenant's covenantd, the SAP SDK's `MetaplexBridge.verifyLink` /
 * `tripleCheckLink`, directory UIs — fetch this document and require:
 *
 *   - `synapseAgent` (string) === the SAP agent PDA in the path, AND
 *   - `authority` (string; the agent's owner wallet)
 *
 * or the link check fails. Field set mirrors the SAP SDK's
 * `buildEip8004Registration()` canonical shape: version, name, description,
 * synapseAgent, authority, capabilities[], services[], executives[],
 * updatedAt, extra.
 *
 * HONESTY CONTRACT (CLAUDE.md "no scaffolding theater"): entries are a
 * column-pinned in-code registry of agents we ACTUALLY registered on-chain,
 * with verifiable tx signatures in `extra`. No live-DB or live-RPC
 * enrichment is claimed — `updatedAt` is the timestamp the entry was last
 * hand-audited, not a liveness signal. When ClawVille agents get SAP
 * identities at scale this becomes a DB lookup; until then a fabricated
 * "dynamic" doc would be scaffolding theater.
 *
 * SECURITY — PUBLIC document, public values only (pubkeys, PDAs, tx sigs).
 * Never add secret material here.
 */

import { Hono } from 'hono';
import bs58 from 'bs58';
import { signPayload } from '../services/service-issuer';

export const agentEip8004Routes = new Hono();

/** Solana mainnet CAIP-2 reference — matches agent-registration.ts. */
const SOLANA_MAINNET_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

interface Eip8004Registration {
  version: string;
  name: string;
  description: string;
  /** Brand image URL — also served as `image` in the token metadata.json. */
  image: string;
  /** SAP AgentAccount PDA (seeds ["sap_agent", wallet]) — the link key. */
  synapseAgent: string;
  /** Agent owner wallet (base58 ed25519). */
  authority: string;
  capabilities: string[];
  services: Array<{ name: string; endpoint: string }>;
  /** Active SAP vault delegates — none provisioned for these agents. */
  executives: never[];
  updatedAt: string;
  extra: Record<string, unknown>;
}

/**
 * SAP-agent registry — one entry per agent whose Metaplex identity asset
 * URI points here. Every value below is on-chain-verifiable (explorer
 * links resolve on the named cluster).
 */
const SAP_AGENT_REGISTRY: Record<string, Eip8004Registration> = {
  Ep7dD7biX7rZ6NSVzy8uEpgEEYipVfQ8ofwHzZmRM8dF: {
    version: '0.1',
    name: 'clawville_genesis',
    description:
      'clawville_genesis — the first ClawVille agent identity (agent–human-economy metaverse at ' +
      'https://clawville.world). SAP-registered on Solana devnet + mainnet (formerly HermesTest; ' +
      'renamed on-chain 2026-07-01) with settled USDC bounty escrows on both, and a Metaplex Core ' +
      'AgentIdentity registered in the mpl-agent-014 (1DREG) registry.',
    image: 'https://clawville.world/press/brand/clawlogo-itachi.jpg',
    synapseAgent: 'Ep7dD7biX7rZ6NSVzy8uEpgEEYipVfQ8ofwHzZmRM8dF',
    authority: '24i43XkDyJAJJBi7X3ARRCt3WBh16uJuSfVRLKXVEYBQ',
    capabilities: ['bounty-execution', 'sap-escrow-settlement', 'x402-payments'],
    services: [
      { name: 'web', endpoint: 'https://clawville.world' },
      {
        name: 'wallet',
        endpoint: `${SOLANA_MAINNET_CAIP2}:24i43XkDyJAJJBi7X3ARRCt3WBh16uJuSfVRLKXVEYBQ`,
      },
    ],
    executives: [],
    updatedAt: '2026-07-02T02:00:00Z',
    extra: {
      metaplexIdentityAsset: {
        mainnet: 'ALcUH8xDxRbqZ7rLMQdXRuvx6TmdSfF7UxQFFe9Ad3om',
        devnet: '8pv2wEMMzhxN51JSsjB4jJM1bjgm8kxZpnA9c2qX3fNX',
      },
      agentIdentityRegistration: {
        registry: 'mpl-agent-014',
        program: '1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p',
        mainnet: '4wuFYaBENsXKSH32owxaPuDSmhrQWoYbfGbaWAKxBZRZ',
        devnet: '5XYgD16jLKWawfxms9NmLguebphQ7oy6uPE2xnm2cLvn',
      },
      bountySettlements: {
        sapEscrowV1: {
          mainnetUsdc:
            '3Az7DTyNQyEHKoMQQjGsxFRBsnLdovNP2cG2V5aJNAvthDuouiBFPMc9NoCHErHNjiecBi9DYxTEoREQ9HMmxP5p',
          devnetUsdc:
            '2G5LcjWV9e2JwHku1DnR32TkSokPf5Xp1UxJPZU2WRDb5F5FNpJvzyuWyfQpyTZbJ73a2LkHptN1QDMGBnQNSLa5',
          devnetSol:
            '47yGsCiDCQqq6om7fSQVENiBkvEQAyKTDU85XDJidmXDcbTXYfj1mR25QR9bjUPuHZf9fozHQGZ8ANvVc7nkv8Nj',
        },
        payaiX402Devnet: [
          '5ULDKnGbHj1hg9JtjTRPVjmqo992TpBUX9uua5exWiUBYQaP5NbEyyn7Hxb39T7cwk638RrPknZPHVs3xtzjTpuQ',
          '3gDsikM6GyJLcz9YfcrrfDnFtdWJ61Ngp6ZFQGAMwSbPRrWhiDmtTscxdMnemn7HV2bpixbHKB7rkhBoTyhngPqp',
        ],
      },
    },
  },
};

/** Base58 32-byte pubkey check — reject malformed probes before the map read. */
function isBase58Pubkey(value: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
}

/**
 * Token-metadata JSON for the agent's MPL Core identity asset — the asset's
 * top-level `uri` points here (its `AgentIdentity` PLUGIN uri stays on
 * eip-8004.json above; wallets/directories read THIS doc for name + image).
 * Derived from the same registry entry so brand + link docs can't drift.
 */
agentEip8004Routes.get('/:sapAgentPda/metadata.json', (c) => {
  const sapAgentPda = c.req.param('sapAgentPda').trim();
  if (!isBase58Pubkey(sapAgentPda)) {
    return c.json({ error: 'not_found' }, 404);
  }
  const registration = SAP_AGENT_REGISTRY[sapAgentPda];
  if (!registration) {
    return c.json({ error: 'not_found' }, 404);
  }
  c.header('Cache-Control', 'public, max-age=300');
  c.header('Content-Type', 'application/json; charset=utf-8');
  return c.json({
    name: registration.name,
    description: registration.description,
    image: registration.image,
    external_url: 'https://clawville.world',
    attributes: [
      { trait_type: 'registry', value: 'mpl-agent-014' },
      { trait_type: 'synapse_agent', value: registration.synapseAgent },
      { trait_type: 'eip_8004', value: `https://api.clawville.world/agents/${registration.synapseAgent}/eip-8004.json` },
    ],
  });
});

agentEip8004Routes.get('/:sapAgentPda/eip-8004.json', (c) => {
  const sapAgentPda = c.req.param('sapAgentPda').trim();
  if (!isBase58Pubkey(sapAgentPda)) {
    return c.json({ error: 'not_found' }, 404);
  }

  const registration = SAP_AGENT_REGISTRY[sapAgentPda];
  if (!registration) {
    return c.json({ error: 'not_found' }, 404);
  }

  // OPTIONAL ClawVille extension — same counter-signing pattern as
  // agent-registration.ts: verifiers can check the issuer key published at
  // /.well-known/clawville-issuer.json. Consumers that only know EIP-8004
  // (the SAP SDK's fetchEip8004Safe) ignore unknown fields.
  let attestation:
    | { algorithm: 'ed25519'; pubkey: string; signature: string; canonicalBody: string }
    | undefined;
  try {
    const signed = signPayload(registration);
    attestation = {
      algorithm: 'ed25519',
      pubkey: signed.pubkey,
      signature: signed.signature,
      canonicalBody: signed.body,
    };
  } catch {
    attestation = undefined; // issuer key unconfigured — doc is valid without it
  }

  c.header('Cache-Control', 'public, max-age=300');
  c.header('Content-Type', 'application/json; charset=utf-8');
  return c.json(
    attestation
      ? { ...registration, 'x-clawville-attestation': attestation }
      : registration,
  );
});
