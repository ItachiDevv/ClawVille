import { expect, test } from 'bun:test';
import { matchesTradingHaltState, startDeclaredGatewayMock } from './hosted-skill-runtime-probe';

test('probe requires preserved fleet halt suppression and disarmed fixture', () => {
  const base = 'Status: armed=false; killed=true\n';
  expect(matchesTradingHaltState(base + 'TRADING IS HALTED:', true, ['mint'])).toBe(true);
  expect(matchesTradingHaltState(base + 'TRADING IS HALTED: Allowed mints: mint', true, ['mint'])).toBe(false);
  expect(matchesTradingHaltState(base + 'Allowed mints: mint', true, ['mint'])).toBe(false);
  expect(matchesTradingHaltState('TRADING IS HALTED:', true, ['mint'])).toBe(false);
  expect(matchesTradingHaltState(base + 'Allowed mints: mint', false, ['mint'])).toBe(true);
  expect(matchesTradingHaltState(base + 'Allowed mints: other', false, ['requiredMintAddress'])).toBe(false);
  expect(matchesTradingHaltState(base + 'TRADING IS HALTED: Allowed mints: mint', false, ['mint'])).toBe(false);
});

test('controlled gateway emits one Nori action only on the requested decision', async () => {
  const mock = await startDeclaredGatewayMock();
  const send = async (content: string) => {
    const response = await fetch(`http://127.0.0.1:${mock.server.port}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content }] }),
    });
    return (await response.json() as any).choices[0].message.content as string;
  };
  try {
    mock.queueNoriQuestion('unique-directive');
    expect(await send('unique-directive chat history')).not.toContain('[ACTION:');
    expect(await send('Available actions (choose exactly one unrelated')).not.toContain('[ACTION:');
    const prompt = 'Available actions (choose exactly one unique-directive';
    expect(await send(prompt)).toBe('[ACTION: chat_nori(message=Where is the Bounty Board and who runs it?)]');
    expect(await send(prompt)).not.toContain('[ACTION:');
    expect(mock.captured).toHaveLength(4);
  } finally { mock.server.stop(true); }
});
