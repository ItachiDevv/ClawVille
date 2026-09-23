import { describe, expect, test } from 'bun:test';
import { isSafeSyntheticChoiceClarification } from './natural-chat-probe-assertions';

describe('synthetic repeated-choice clarification', () => {
  for (const reply of [
    'It looks like you\'re trying to adjust your order again! Since the previous item was already added, are you looking to remove that sandwich and start over with "no mayo," or would you like to add a new item? Let me know how I can help!',
    'Which item do you mean? I have not changed anything.',
    'Would you like to remove the existing sandwich and start again without mayo?',
    'Should I change the sandwich or help you choose another item?',
  ]) test(`accepts clarification: ${reply.slice(0, 45)}`, () => {
    expect(isSafeSyntheticChoiceClarification(reply)).toBe(true);
  });
  for (const reply of [
    'I removed the mayo. Which item next?',
    "I've updated the sandwich. Would you like another item?",
    'Your sandwich has already been changed. Which item next?',
    'Your sandwich is now mayo-free. What item next?',
    'Done! Would you like another item?',
    'Another sandwich was added. Which item next?',
    'Added a sandwich without mayo. Which item next?',
    'Mayo removed. Which item next?',
    'Your order is confirmed. Which item next?',
    'Payment confirmed. Which item next?',
    'No mayo noted.',
    'Which item? ' + 'x'.repeat(1200),
  ]) test(`rejects unsupported claim or non-clarification: ${reply.slice(0, 45)}`, () => {
    expect(isSafeSyntheticChoiceClarification(reply)).toBe(false);
  });
});
