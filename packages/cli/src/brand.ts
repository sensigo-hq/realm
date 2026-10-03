// This package's release mark (issue #620 PR-B): what every class `@sensigo/realm-cli` exports carries on its
// prototype, so copies of the same release recognise each other's objects. See `brand.ts` in
// `@sensigo/realm` for what the mark is and how it is checked.
import { createRealmBrand, type RealmBrand } from '@sensigo/realm';
import { VERSION } from './version.js';

export const REALM_CLI_BRAND: RealmBrand = createRealmBrand(
  '@sensigo/realm-cli',
  VERSION,
  typeof import.meta.url === 'string' ? new URL('../', import.meta.url).href : null,
);
