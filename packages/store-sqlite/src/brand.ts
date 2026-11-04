// This package's release mark (issue #620 PR-B; issue #616 unit 1): what every class
// `@sensigo/realm-store-sqlite` exports carries on its prototype, so copies of the same release
// recognise each other's objects. See `brand.ts` in `@sensigo/realm` for what the mark is and how it
// is checked.
import { createRealmBrand, type RealmBrand } from '@sensigo/realm';
import { VERSION } from './version.js';

export const REALM_STORE_SQLITE_BRAND: RealmBrand = createRealmBrand(
  '@sensigo/realm-store-sqlite',
  VERSION,
  typeof import.meta.url === 'string' ? new URL('../', import.meta.url).href : null,
);
