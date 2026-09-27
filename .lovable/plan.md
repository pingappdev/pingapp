# Bring PingApp into this project

Your upload contains the full PingApp site and dashboard (marketing pages, dashboard, styles, brand images, database setup, and balance lookup). I'll import it here, keep the design exactly as supplied, and wire up the backend.

## What you'll get

- The PingApp marketing site at the home page, with all sections, navigation menu, hero slider, insights pages, contact, privacy and terms.
- The charcoal/purple/pink/red dashboard at `/dashboard` with overview, send, contacts, activity and settings.
- Email sign-in link, per-account data isolation, and the same "coming soon" social dialogs.
- Live balances on Robinhood Chain, Ethereum and Arbitrum, plus wallet connect and transfer review.

## Approach

1. Copy the source in: all pages, styles, shared UI parts, and brand images (brand artwork kept exactly as supplied).
2. Adapt page navigation to this project's built-in routing system, keeping the smooth page transitions, persistent dashboard, and reduced-motion behaviour.
3. Turn on Lovable Cloud and apply the supplied database setup (profiles, contacts, activity) with row-level security and the Robinhood Chain update folded in.
4. Rebuild the balance lookup as a secure server call in this project instead of a separate edge function, with the same signed-in check.
5. Install the packages the imported code needs.
6. Set page titles and descriptions per page.

## Kept as-is

- No phone verification or registered-number lookup is invented; the existing unavailable state stays.
- No USDC on Robinhood Chain; native ETH only there.
- Historical Base activity keeps its original explorer links.

## Verification

Sign in, add/search/remove a contact, reload for persistence, change profile settings, refresh balances on all three networks, export activity, browse back/forward, check mobile menu and social dialogs, and open the transfer review without submitting a transaction.

## Technical notes

- Routing converts from React Router to TanStack Router file routes (`/`, marketing paths, `/login`, `/logout`, `/dashboard/$view`); `usePathname`/`useRouter`/`useSearchParams` shims re-point to TanStack equivalents.
- `globals.css` + vendored shadcn CSS replace `src/styles.css`; assets go to `public/assets`.
- `functions.invoke('balances')` becomes a `createServerFn` handler using the supplied `_shared/network-balances.ts` logic, auth-checked via the caller's session.
- Migrations merged into a single Lovable Cloud migration with explicit GRANTs.
