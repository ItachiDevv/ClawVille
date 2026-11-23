import {sql,type SQL} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import type {TransactionSql} from 'postgres';
import {BRAINCHAIN_BUYER_LANE} from '@clawville/shared';

/** All spend-policy writers use this same account lock before admission. */
export function accountSpendLockKey(avatarId:string):string{return `spend-policy:${avatarId}`;}
/** One liability per authorization. No buyer operation inserts a vendor ledger row. */
export function accountSpendLiabilityQuery(avatarId:string):SQL{
 return sql`WITH owner AS (SELECT ${avatarId}::uuid AS avatar_id), boundary AS
  (SELECT date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS day_start)
  SELECT (
   COALESCE((SELECT SUM(usdc_atomic) FROM vendor_spend_ledger,owner,boundary
    WHERE vendor_spend_ledger.avatar_id=owner.avatar_id
    AND (status IN ('pending','ambiguous') OR (status='paid' AND created_at>=boundary.day_start))),0)
   + COALESCE((SELECT SUM(${BRAINCHAIN_BUYER_LANE.amountAtomic}::numeric) FROM brainchain_buyer_orders,owner
    WHERE brainchain_buyer_orders.avatar_id=owner.avatar_id AND reserved_at IS NOT NULL
    AND state IN ('reserved','captured','sending','uncertain','payment_observed','refunded','reorg_suspended')),0)
  )::text AS total`;
}
const dialect=new PgDialect();
/** Same SQL for postgres.js buyers and Drizzle vendor admission. Caller already holds the account lock. */
export async function readAccountSpendLiability(tx:TransactionSql,avatarId:string):Promise<bigint>{
 const query=dialect.sqlToQuery(accountSpendLiabilityQuery(avatarId));
 const [row]=await tx.unsafe<{total:string}[]>(query.sql,query.params.map(value=>{if(typeof value!=='string')throw new Error('Invalid liability query parameter');return value;}));
 if(!row||!/^\d+$/.test(row.total))throw new Error('Invalid account spend liability');
 return BigInt(row.total);
}
