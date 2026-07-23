import type { CashSettledHandSnapshot } from '@clawville/shared';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

const idParamSchema = z.object({ id: z.string().uuid() });
const afterHandNumberSchema = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().nonnegative().safe());

/** Dependency-light BA-1 handler seam: safe to execute without boot/env imports. */
export function createLastSettledHandler(deps: {
  resolveRequestSubject: (c: Context) => Promise<{ avatarId: string }>;
  getLastSettledHand: (
    tableId: string,
    requesterAvatarId: string,
    afterHandNumber: number,
  ) => Promise<CashSettledHandSnapshot | null>;
}) {
  return async (c: Context) => {
    const parsed = idParamSchema.safeParse(c.req.param());
    if (!parsed.success) throw new HTTPException(400, { message: 'invalid_table_id' });
    const afterParsed = afterHandNumberSchema.safeParse(c.req.query('afterHandNumber'));
    if (!afterParsed.success) {
      throw new HTTPException(400, { message: 'invalid_after_hand_number' });
    }
    const subject = await deps.resolveRequestSubject(c);
    try {
      const snapshot = await deps.getLastSettledHand(
        parsed.data.id,
        subject.avatarId,
        afterParsed.data,
      );
      if (!snapshot) return c.body(null, 204);
      return c.json({ snapshot }, 200);
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      const cashError = error as {
        httpStatus?: number;
        code?: string;
      };
      if (cashError.httpStatus && cashError.code) {
        throw new HTTPException(cashError.httpStatus as 400, {
          message: cashError.code,
        });
      }
      throw error;
    }
  };
}
