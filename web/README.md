# Cameraman Web

React + Vite + TypeScript, Tailwind v4, shadcn/ui (dark by default), TanStack Query, Zustand, React Router.

## Setup

```sh
pnpm install
cp .env.example .env   # optional
pnpm dev               # http://localhost:5173
```

## Scripts

| Command          | Purpose                                  |
| ---------------- | ---------------------------------------- |
| `pnpm dev`       | Vite dev server                          |
| `pnpm build`     | Typecheck + production build to `dist/`  |
| `pnpm lint`      | ESLint                                   |
| `pnpm typecheck` | `tsc -b --noEmit`                        |
| `pnpm test`      | Vitest (watch); `pnpm test --run` for CI |

## Environment

| Var                 | Default                        | Meaning          |
| ------------------- | ------------------------------ | ---------------- |
| `VITE_API_BASE_URL` | `http://localhost:8080/api/v1` | Backend REST API |

## Layout

- `src/lib/api.ts` typed fetch client: bearer token, single-flight refresh on 401 (retry once), logout on refresh failure.
- `src/stores/auth.ts` Zustand store (persisted to localStorage key `cameraman-auth`), `hasRole` (admin > operator > viewer).
- `src/features/auth/actions.ts` login / register / logout.
- `src/routes/` router + `RequireAuth` / `RequireRole` guards.
- `src/components/ui/` shadcn/ui (add more with `pnpm dlx shadcn@latest add <name>`).
- `src/components/layout/` app shell: collapsible sidebar, top bar, user menu, theme toggle.
- `src/types/api.ts` API entity types (SPEC section 7).

## Auth API contract assumed

`POST /auth/login|register` -> `{ access_token, refresh_token, user }`;
`POST /auth/refresh {refresh_token}` -> `{ access_token, refresh_token, user? }`;
`POST /auth/logout {refresh_token}`. Adjust `src/types/api.ts` + `src/features/auth/actions.ts` if the backend differs.
