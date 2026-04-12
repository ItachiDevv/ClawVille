import type { Action, ActionResult } from './types';
import { hasServices, getMessageText, getParam } from './types';

/** Platform fee percentage for bazaar transactions (15%). */
const PLATFORM_FEE_PERCENT = 15;

/**
 * BUY_BAZAAR_LISTING — purchase a skill listing from the ClawVille bazaar.
 *
 * Flow:
 *  1. Find the listing (must be active)
 *  2. Verify buyer has enough NeoTokens
 *  3. Debit buyer, credit seller (minus 15% platform fee)
 *  4. Mark listing as sold
 *  5. Record the transaction
 *  6. Add the skill to buyer's inventory
 *
 * Parameters:
 *   listingId — UUID of the bazaar listing
 */
export const buyBazaarListingAction: Action = {
  name: 'BUY_BAZAAR_LISTING',
  description:
    'Purchase a skill listing from the ClawVille bazaar marketplace.',
  similes: [
    'BUY_SKILL',
    'PURCHASE_LISTING',
    'BUY_FROM_BAZAAR',
    'MARKETPLACE_BUY',
  ],

  parameters: [
    {
      name: 'listingId',
      description: 'The UUID of the bazaar listing to purchase.',
      required: true,
      schema: { type: 'string' },
    },
  ],

  examples: [
    [
      {
        user: '{{user1}}',
        content: {
          text: 'Buy that skill from the bazaar',
          action: 'BUY_BAZAAR_LISTING',
        },
      },
    ],
    [
      {
        user: '{{user1}}',
        content: {
          text: 'Purchase listing abc123 from the marketplace',
          action: 'BUY_BAZAAR_LISTING',
        },
      },
    ],
  ],

  async validate(_runtime: any, message: any, _state?: any): Promise<boolean> {
    const text = getMessageText(message).toLowerCase();
    const triggers = [
      'bazaar',
      'buy listing',
      'purchase skill',
      'marketplace buy',
      'buy from market',
    ];
    return triggers.some((t) => text.includes(t));
  },

  async handler(
    _runtime: any,
    message: any,
    state?: any,
    _options?: any,
    _callback?: any,
  ): Promise<ActionResult> {
    try {
      if (!hasServices(state)) {
        return { success: false, text: 'Service layer not available' };
      }

      const { petId, services } = state;
      const { db, debitNeoTokens, creditNeoTokens } = services;

      const listingId = getParam(message, 'listingId');
      if (!listingId) {
        return {
          success: false,
          text: 'Please specify a listing ID to purchase.',
        };
      }

      const {
        bazaarListings,
        bazaarTransactions,
        publishedSkills,
        petInventory,
        pets,
        eq,
        and,
      } = await import('@clawville/database');

      // 1. Find the listing
      const [listing] = await db
        .select({
          id: bazaarListings.id,
          skillId: bazaarListings.skillId,
          sellerId: bazaarListings.sellerId,
          price: bazaarListings.price,
          status: bazaarListings.status,
        })
        .from(bazaarListings)
        .where(eq(bazaarListings.id, listingId))
        .limit(1);

      if (!listing) {
        return { success: false, text: 'Listing not found.' };
      }

      if (listing.status !== 'active') {
        return {
          success: false,
          text: `This listing is no longer active (status: ${listing.status}).`,
        };
      }

      // Cannot buy your own listing
      if (listing.sellerId === petId) {
        return { success: false, text: 'You cannot buy your own listing.' };
      }

      // 2. Check buyer balance
      const [buyer] = await db
        .select({ neoTokens: pets.neoTokens })
        .from(pets)
        .where(eq(pets.id, petId))
        .limit(1);

      if (!buyer) {
        return { success: false, text: 'Pet not found.' };
      }

      if (buyer.neoTokens < listing.price) {
        return {
          success: false,
          text: `Not enough NeoTokens. You have ${buyer.neoTokens} NT but this listing costs ${listing.price} NT.`,
        };
      }

      // 3. Calculate fees
      const platformFee = Math.floor(
        (listing.price * PLATFORM_FEE_PERCENT) / 100,
      );
      const sellerPayout = listing.price - platformFee;

      // 4. Debit buyer
      const { balanceAfter: buyerBalance } = await debitNeoTokens({
        petId,
        amount: listing.price,
        reason: `Bazaar purchase: listing ${listingId}`,
        source: 'bazaar',
        metadata: { listingId, skillId: listing.skillId },
      });

      // 5. Credit seller (minus platform fee)
      await creditNeoTokens({
        petId: listing.sellerId,
        amount: sellerPayout,
        reason: `Bazaar sale: listing ${listingId}`,
        source: 'bazaar',
        metadata: {
          listingId,
          skillId: listing.skillId,
          platformFee,
        },
      });

      // 6. Mark listing as sold
      await db
        .update(bazaarListings)
        .set({ status: 'sold', updatedAt: new Date() })
        .where(eq(bazaarListings.id, listingId));

      // 7. Record transaction
      await db.insert(bazaarTransactions).values({
        listingId: listing.id,
        buyerId: petId,
        sellerId: listing.sellerId,
        skillId: listing.skillId,
        price: listing.price,
        platformFee,
        sellerPayout,
      });

      // 8. Get skill info for confirmation
      const [skill] = await db
        .select({ name: publishedSkills.name, description: publishedSkills.description })
        .from(publishedSkills)
        .where(eq(publishedSkills.id, listing.skillId))
        .limit(1);

      // 9. Add skill to buyer's inventory (use skill ID as itemId)
      const skillItemId = `skill-${listing.skillId}`;
      const [existingInv] = await db
        .select({ id: petInventory.id, quantity: petInventory.quantity })
        .from(petInventory)
        .where(
          and(eq(petInventory.petId, petId), eq(petInventory.itemId, skillItemId)),
        )
        .limit(1);

      if (existingInv) {
        await db
          .update(petInventory)
          .set({ quantity: existingInv.quantity + 1 })
          .where(eq(petInventory.id, existingInv.id));
      } else {
        await db.insert(petInventory).values({
          petId,
          itemId: skillItemId,
          quantity: 1,
        });
      }

      return {
        success: true,
        text: [
          `Purchased **${skill?.name ?? 'skill'}** from the bazaar for ${listing.price} NT.`,
          `Platform fee: ${platformFee} NT | Seller received: ${sellerPayout} NT`,
          `Your new balance: ${buyerBalance} NT`,
        ].join('\n'),
        data: {
          listingId: listing.id,
          skillId: listing.skillId,
          skillName: skill?.name,
          price: listing.price,
          platformFee,
          sellerPayout,
          buyerBalance,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        text: error.message ?? 'Failed to buy bazaar listing',
      };
    }
  },

  suppressPostActionContinuation: false,
};
