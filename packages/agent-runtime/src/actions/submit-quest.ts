import type { Action, ActionResult } from './types';
import { hasServices, getMessageText, getParam, getDbModule } from './types';

/**
 * SUBMIT_QUEST — submit completed work on an accepted quest for human review.
 *
 * Completes the hosted-agent quest lifecycle that ACCEPT_QUEST starts (Codex
 * adversarial round 3, 2026-07-13: hosted cognition could accept a quest but
 * had no way to submit it — the advertised parity lifecycle was unreachable).
 * Mirrors the REST `POST /api/quests/:id/submit` invariants exactly:
 *
 *   - Single compare-and-set: the allowed source statuses ('accepted',
 *     'in_progress') live INSIDE the update's WHERE, so a stale submit can
 *     never regress a row an admin has already reviewed.
 *   - Note length bounds match the route's zod schema (10–2000 chars).
 *   - Submitting from 'accepted' directly is legal (same as the route — the
 *     explicit start step is optional).
 *
 * Parameters:
 *   questId — UUID of the quest whose accepted submission to submit
 *   note    — what was done (10–2000 chars; becomes submissionNote)
 *   prLink  — optional GitHub pull-request URL evidencing the work
 */
export const submitQuestAction: Action = {
  name: 'SUBMIT_QUEST',
  description:
    'Submit your completed work on an accepted quest for reviewer approval (rewards pay after a human review).',
  similes: [
    'COMPLETE_QUEST',
    'TURN_IN_QUEST',
    'FINISH_QUEST',
    'DELIVER_QUEST',
    'SUBMIT_MISSION',
  ],

  parameters: [
    {
      name: 'questId',
      description: 'The UUID of the quest to submit work for.',
      required: true,
      schema: { type: 'string' },
    },
    {
      name: 'note',
      description:
        'Description of the completed work (10–2000 characters). Becomes the submission note the reviewer reads.',
      required: true,
      schema: { type: 'string' },
    },
    {
      name: 'prLink',
      description: 'Optional GitHub pull-request URL evidencing the work.',
      required: false,
      schema: { type: 'string' },
    },
  ],

  examples: [
    [
      {
        user: '{{user1}}',
        content: { text: 'Submit my quest work', action: 'SUBMIT_QUEST' },
      },
    ],
    [
      {
        user: '{{user1}}',
        content: { text: 'Turn in the completed mission', action: 'SUBMIT_QUEST' },
      },
    ],
  ],

  async validate(_runtime: any, message: any, _state?: any): Promise<boolean> {
    // Structured invocation path (executeAction builds a synthetic message
    // with EMPTY text but real parameters — Codex round 4): a present questId
    // param IS the intent signal; trigger words are the natural-language
    // fallback only.
    if (getParam(message, 'questId')) return true;
    const text = getMessageText(message).toLowerCase();
    const triggers = [
      'submit',
      'turn in',
      'complete quest',
      'finish quest',
      'deliver',
      'quest',
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

      const { avatarId, services } = state;
      const { db } = services;

      const questId = getParam(message, 'questId');
      if (!questId) {
        return { success: false, text: 'Please specify a quest ID to submit.' };
      }

      const note = getParam(message, 'note');
      if (!note || note.length < 10 || note.length > 2000) {
        return {
          success: false,
          text: 'A submission note of 10–2000 characters is required — describe what you did.',
        };
      }

      const prLink = getParam(message, 'prLink') ?? null;
      if (prLink && !/^https:\/\/github\.com\/.+\/.+\/pull\/\d+/.test(prLink)) {
        return {
          success: false,
          text: 'prLink must be a GitHub pull request URL (https://github.com/<org>/<repo>/pull/<n>).',
        };
      }

      const { quests, questSubmissions, avatars, users, eq, and, inArray } = await getDbModule();

      // Canonical identity gate (Codex round 5) — same fail-closed check as
      // ACCEPT_QUEST: the supplied avatarId must be a real avatars.id with a
      // non-guest owner, no matter which runtime injected the state.
      const [actor] = await db
        .select({ id: avatars.id, isGuest: users.isGuest })
        .from(avatars)
        .innerJoin(users, eq(users.id, avatars.userId))
        .where(eq(avatars.id, avatarId))
        .limit(1);
      if (!actor) {
        return {
          success: false,
          text: 'quest_actor_unresolved: this runtime is not bound to a real avatar, so it cannot use the quest board.',
        };
      }
      if (actor.isGuest) {
        return {
          success: false,
          text: 'Guests run a demo economy — quest rewards pay real vCLAW, so the quest board needs a full account.',
        };
      }

      const now = new Date();

      // Compare-and-set: only an 'accepted'/'in_progress' row can move to
      // 'submitted' — an approved/rejected/submitted row never matches, so a
      // stale or duplicate submit cannot reopen or double-queue a review.
      // Covenant record in the same tx when the injected recorder is present
      // (runtime-services-adapter pre-binds the surface's actor kind).
      const record = services.recordCovenantAction;
      const [updated] = await db.transaction(async (tx: any) => {
        const rows = await tx
          .update(questSubmissions)
          .set({
            status: 'submitted',
            submissionNote: note,
            prLink,
            submittedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(questSubmissions.questId, questId),
              eq(questSubmissions.avatarId, avatarId),
              inArray(questSubmissions.status, ['accepted', 'in_progress']),
            ),
          )
          .returning({ id: questSubmissions.id });
        if (rows[0] && record) {
          const { createHash } = await import('crypto');
          await record(
            {
              action: 'quest.submit',
              subjectType: 'avatar',
              subjectId: avatarId,
              payload: {
                questId,
                submissionId: rows[0].id,
                ...(prLink ? { prLink } : {}),
                noteSha256: createHash('sha256').update(note, 'utf8').digest('hex'),
                noteLength: note.length,
              },
            },
            tx,
          );
        }
        return rows;
      });

      if (!updated) {
        return {
          success: false,
          text: 'No active submission found for this quest — accept it first (or it was already submitted/reviewed).',
        };
      }

      const [quest] = await db
        .select({ title: quests.title, tokenReward: quests.tokenReward })
        .from(quests)
        .where(eq(quests.id, questId))
        .limit(1);

      return {
        success: true,
        text: [
          `Work submitted${quest ? ` for **${quest.title}**` : ''} — a human reviewer will approve or reject it.`,
          quest ? `Reward on approval: ${quest.tokenReward} vCLAW.` : '',
          'Check your quest log for the verdict.',
        ]
          .filter(Boolean)
          .join(' '),
        data: { questId, submissionId: updated.id },
      };
    } catch (error: any) {
      return { success: false, text: error.message ?? 'Failed to submit quest' };
    }
  },

  suppressPostActionContinuation: false,
};
