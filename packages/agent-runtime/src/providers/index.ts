export type { Provider, ProviderResult } from './types';

export { petStateProvider } from './pet-state';
export { worldStateProvider } from './world-state';
export { inventoryProvider } from './inventory';
export { questProvider } from './quest';
export { knowledgeProvider } from './knowledge';

import { petStateProvider } from './pet-state';
import { worldStateProvider } from './world-state';
import { inventoryProvider } from './inventory';
import { questProvider } from './quest';
import { knowledgeProvider } from './knowledge';

/** All providers in registration order (sorted by position). */
export const allProviders = [
  petStateProvider,   // position 10
  worldStateProvider, // position 20
  inventoryProvider,  // position 30
  questProvider,      // position 40
  knowledgeProvider,  // position 50
];
