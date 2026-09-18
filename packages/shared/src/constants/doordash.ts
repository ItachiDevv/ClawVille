/** Server-owned intent values are literal constants: no interpolation or caller text. */
export const DD_CLI_PINNED_VERSION = '0.2.4';

export const DD_CLI_OPERATIONS = [
  'version', 'address-list', 'search', 'menu', 'find-items', 'item-details',
  'cart-show', 'cart-add', 'cart-remove', 'order-preview', 'order-submit',
  'order-status', 'order-history',
  // 2026-09-18 demo patch: non-restaurant discovery (Wawa is a convenience
  // store, invisible to `search`), the option list for customizable items, and
  // a cart add that carries server-built option choices.
  'nearby-stores', 'item-options', 'cart-add-options',
] as const;
export type DdCliOperation = (typeof DD_CLI_OPERATIONS)[number];

/** Two-line format: docs/ddcli-help/address-list.txt, --intent. */
export const DD_CLI_INTENTS: Readonly<Record<DdCliOperation, string>> = Object.freeze({
  version: 'Summary: Help the account owner check personal DoorDash access.\nuser prompt/purpose: "Check the personal integration."',
  'address-list': 'Summary: Help the account owner choose a saved delivery address for a personal meal.\nuser prompt/purpose: "Review saved delivery addresses."',
  search: 'Summary: Help the account owner find a restaurant for a personal meal.\nuser prompt/purpose: "Find a restaurant for a personal meal."',
  menu: 'Summary: Help the account owner choose food for a personal meal.\nuser prompt/purpose: "Review the restaurant menu."',
  'find-items': 'Summary: Help the account owner find items for a personal purchase.\nuser prompt/purpose: "Find items for a personal purchase."',
  'item-details': 'Summary: Help the account owner review an item for a personal purchase.\nuser prompt/purpose: "Review the item details."',
  'cart-show': 'Summary: Help the account owner review a personal meal before purchase.\nuser prompt/purpose: "Review the personal cart."',
  'cart-add': 'Summary: Help the account owner prepare a personal meal for purchase.\nuser prompt/purpose: "Prepare the personal cart."',
  'cart-remove': 'Summary: Help the account owner adjust a personal meal before purchase.\nuser prompt/purpose: "Adjust the personal cart."',
  'order-preview': 'Summary: Help the account owner review the cost of a personal meal.\nuser prompt/purpose: "Review the personal order before confirmation."',
  'order-submit': 'Summary: Help the account owner purchase a personally confirmed meal.\nuser prompt/purpose: "Purchase the personally confirmed meal."',
  'order-status': 'Summary: Help the account owner track a personal meal order.\nuser prompt/purpose: "Check the personal order status."',
  'order-history': 'Summary: Help the account owner review previous personal meal orders.\nuser prompt/purpose: "Review personal order history."',
  'nearby-stores': 'Summary: Help the account owner find a store for a personal meal.\nuser prompt/purpose: "Find a nearby store for a personal meal."',
  'item-options': 'Summary: Help the account owner choose options for a personal meal.\nuser prompt/purpose: "Review the choices for a menu item."',
  'cart-add-options': 'Summary: Help the account owner prepare a personal meal for purchase.\nuser prompt/purpose: "Prepare the personal cart."',
});
