/**
 * ClawVille game plugin — bundles all game-specific Actions and Providers
 * into a single ElizaOS Plugin export that gets registered on the runtime.
 *
 * This is NOT loaded via the plugin priority chain (that's for model
 * providers). Instead, it's registered directly by ElizaRuntime.start()
 * so the actions and providers are available to processMessage.
 */

import { allActions } from '../actions/index';
import { allProviders } from '../providers/index';
import type { Action } from '../actions/types';
import type { Provider } from '../providers/types';

export interface ClawvillePlugin {
  name: string;
  description: string;
  actions: Action[];
  providers: Provider[];
}

export const clawvillePlugin: ClawvillePlugin = {
  name: '@clawville/game-plugin',
  description:
    'ClawVille game operations — actions (visit building, buy item, learn skill, etc.) and providers (avatar state, world state, inventory, quests, knowledge) for the agent runtime.',
  actions: allActions as Action[],
  providers: allProviders as Provider[],
};
