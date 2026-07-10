import { z } from 'zod';

/** Pure register body contract, split out so validation tests need no route/runtime boot. */
export const registerSchema = z
  .object({
    name: z.string().min(1).max(64),
    description: z.string().trim().min(1).max(512),
    capabilities: z
      .array(
        z.object({
          id: z.string().min(1).max(64),
          description: z.string().max(256).nullish(),
          protocolId: z.string().max(64).nullish(),
          version: z.string().max(32).nullish(),
        }),
      )
      .max(32)
      .default([]),
    protocols: z.array(z.string().min(1).max(64)).max(16).default(['clawville']),
    agentId: z.string().max(64).nullish(),
    agentUri: z.string().url().max(256).nullish(),
    x402Endpoint: z.string().url().max(256).nullish(),
  })
  .strict();
