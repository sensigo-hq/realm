// This package's release mark (issue #620 PR-B): what every class `@sensigo/realm-testing` exports carries on its
// prototype, so copies of the same release recognise each other's objects. See `brand.ts` in
// `@sensigo/realm` for what the mark is and how it is checked.
import { createRealmBrand, type RealmBrand } from '@sensigo/realm';
import { VERSION } from './version.js';

export const REALM_TESTING_BRAND: RealmBrand = createRealmBrand(
  '@sensigo/realm-testing',
  VERSION,
  typeof import.meta.url === 'string' ? new URL('../', import.meta.url).href : null,
);
