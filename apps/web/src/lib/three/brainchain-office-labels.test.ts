import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import BrainchainOfficeWorld from './brainchain-office';

test('Office warm attachment visibility reaches the label owner', () => {
  const wrapper = BrainchainOfficeWorld({ showGuide: false });
  const child = wrapper.props.children;
  expect(typeof child).toBe('function');
  expect(child(false).props).toMatchObject({ attachmentVisible: false, showGuide: false });
  expect(child(true).props).toMatchObject({ attachmentVisible: true, showGuide: false });
});

test('Office labels start gated, refresh visibility, and use finite pavilion fade distances', () => {
  const source = readFileSync(new URL('./brainchain-office.tsx', import.meta.url), 'utf8');
  expect(source.match(/initialVisible: attachmentVisible, fadeNear: 800, fadeFar: 4500/g)?.length).toBe(2);
  expect(source).toContain('officeLabel.setVisible(attachmentVisible)');
  expect(source).toContain('guideLabel.setVisible(attachmentVisible && showGuide)');
});
