/**
 * EIP-8004 agent registration JSON for SAP-registered ClawVille agents
 * (the Metaplex `AgentIdentity` / mpl-agent-014 identity rail).
 *
 *   GET /agents/:sapAgentPda/eip-8004.json
 *
 * This URL shape is LOAD-BEARING and immutable once minted: each agent's
 * MPL Core identity asset carries an `AgentIdentity` external plugin whose
 * `uri` points at exactly `https://api.clawville.world/agents/<sapAgentPda>/eip-8004.json`
 * (the historical genesis asset used 1DREG `RegisterIdentityV1`; automatic
 * DB-backed identities use the SDK 1.0.0 direct MPL Core external-plugin
 * adapter). Verifiers —
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
 * HONESTY CONTRACT (CLAUDE.md "no scaffolding theater"): the hand-audited
 * genesis entry below is authoritative and checked first. Every other entry
 * comes from `sap_agent_identities` only when its lifecycle proves an on-chain
 * registration and carries a real Solana registration signature. Pending,
 * failed, or signature-less rows stay opaque 404s.
 *
 * SECURITY — PUBLIC document, public values only (pubkeys, PDAs, tx sigs).
 * Never add secret material here.
 */

import { Hono } from 'hono';
import bs58 from 'bs58';
import {
  and,
  db,
  eq,
  inArray,
  isNotNull,
  sapAgentIdentities,
  type SapAgentIdentity,
} from '@clawville/database';
import { signPayload } from '../services/service-issuer';

export const agentEip8004Routes = new Hono();

/** Solana mainnet CAIP-2 reference — matches agent-registration.ts. */
const SOLANA_MAINNET_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
/** Solana devnet CAIP-2 reference. */
const SOLANA_DEVNET_CAIP2 = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const CLAWVILLE_AGENT_IMAGE = 'https://clawville.world/press/brand/clawlogo-itachi.jpg';
const PROVABLY_REGISTERED_STATUSES = [
  'registered',
  'attaching_identity',
  'identity_attached',
] as const;

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

/** Normalize persisted SDK capability objects into the public EIP string list. */
function dbCapabilities(value: SapAgentIdentity['capabilities']): string[] {
  if (!Array.isArray(value)) return [];
  const capabilities: unknown[] = value;
  return capabilities.flatMap((capability) => {
    if (typeof capability === 'string') return capability.length > 0 ? [capability] : [];
    if (
      capability &&
      typeof capability === 'object' &&
      typeof (capability as { id?: unknown }).id === 'string'
    ) {
      const id = (capability as { id: string }).id.trim();
      return id.length > 0 ? [id] : [];
    }
    return [];
  });
}

function isProvablyRegistered(row: SapAgentIdentity): boolean {
  return (
    (PROVABLY_REGISTERED_STATUSES as readonly string[]).includes(row.status) &&
    typeof row.registerTxSig === 'string' &&
    isBase58Signature(row.registerTxSig)
  );
}

function registrationFromDb(row: SapAgentIdentity): Eip8004Registration {
  const caip2 = row.cluster === 'mainnet' ? SOLANA_MAINNET_CAIP2 : SOLANA_DEVNET_CAIP2;
  const extra: Record<string, unknown> = {
    cluster: row.cluster,
    registerTxSig: row.registerTxSig,
  };
  if (row.metaplexAsset) {
    extra.metaplexAsset = row.metaplexAsset;
    extra.metaplexIdentityAsset = { [row.cluster]: row.metaplexAsset };
  }
  if (row.identityRegistration) {
    extra.identityRegistration = row.identityRegistration;
    extra.agentIdentityRegistration = {
      registry: 'mpl-agent-014',
      program: '1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p',
      [row.cluster]: row.identityRegistration,
    };
  }
  if (row.metaplexTxSig) extra.metaplexTxSig = row.metaplexTxSig;

  return {
    version: '0.1',
    name: row.name,
    description: row.description,
    image: CLAWVILLE_AGENT_IMAGE,
    synapseAgent: row.agentPda,
    authority: row.wallet,
    capabilities: dbCapabilities(row.capabilities),
    services: [
      { name: 'web', endpoint: 'https://clawville.world' },
      { name: 'wallet', endpoint: `${caip2}:${row.wallet}` },
    ],
    executives: [],
    updatedAt: row.updatedAt.toISOString(),
    extra,
  };
}

/** Genesis is authoritative; all other identities must satisfy the DB proof predicate. */
async function resolveRegistration(
  sapAgentPda: string,
): Promise<Eip8004Registration | null> {
  const genesis = SAP_AGENT_REGISTRY[sapAgentPda];
  if (genesis) return genesis;

  try {
    const row = await db.query.sapAgentIdentities.findFirst({
      where: and(
        eq(sapAgentIdentities.agentPda, sapAgentPda),
        inArray(sapAgentIdentities.status, [...PROVABLY_REGISTERED_STATUSES]),
        isNotNull(sapAgentIdentities.registerTxSig),
      ),
    });
    // Defense in depth for alternative DB adapters/test doubles: never trust a
    // row that does not itself satisfy the public-document honesty contract.
    return row && isProvablyRegistered(row) ? registrationFromDb(row) : null;
  } catch {
    console.warn('[agent-eip8004] identity registry lookup failed; serving opaque not_found');
    return null;
  }
}

function isBase58Signature(value: string): boolean {
  try {
    return bs58.decode(value).length === 64;
  } catch {
    return false;
  }
}

/** Base58 32-byte pubkey check; reject malformed probes before any DB read. */
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
agentEip8004Routes.get('/:sapAgentPda/metadata.json', async (c) => {
  const sapAgentPda = c.req.param('sapAgentPda').trim();
  if (!isBase58Pubkey(sapAgentPda)) {
    return c.json({ error: 'not_found' }, 404);
  }
  const registration = await resolveRegistration(sapAgentPda);
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

agentEip8004Routes.get('/:sapAgentPda/eip-8004.json', async (c) => {
  const sapAgentPda = c.req.param('sapAgentPda').trim();
  if (!isBase58Pubkey(sapAgentPda)) {
    return c.json({ error: 'not_found' }, 404);
  }

  const registration = await resolveRegistration(sapAgentPda);
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
