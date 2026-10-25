# Cameraman Mobile (monitor-only)

Expo (SDK 58) + expo-router + TypeScript app for monitoring Cameraman cameras.

**Scope: monitor only.** Sign in (viewer), live camera grid + single view, event feed, push alerts.
There is no UI to create, edit or delete cameras or workflows; do those in the web app.

## Setup

```sh
pnpm install
cp .env.example .env   # optional
pnpm start             # then open in Expo Go / a dev build
```

## Env

| Var | Default |
| --- | --- |
| `EXPO_PUBLIC_API_BASE_URL` | `http://localhost:8080/api/v1` |

On a physical device or emulator, `localhost` is the device itself; use your machine's LAN IP
(Android emulator: `http://10.0.2.2:8080/api/v1`).

## Scripts

- `pnpm lint` - expo lint (ESLint 9)
- `pnpm typecheck` - `tsc --noEmit`
- `pnpm test` - jest-expo, single run (`--ci --watchAll=false`)

## Layout

- `src/lib/api.ts` - typed client: bearer, 401 -> single-flight refresh -> retry -> logout (mirrors web)
- `src/stores/auth.ts` - zustand store persisted via `expo-secure-store` (AsyncStorage fallback)
- `src/lib/push.ts` - `expo-notifications` registration + payload -> route mapping
- `src/app` - `login`, `(tabs)/{index=Cameras,events,settings}`, `camera/[id]`

## Live view

v1 polls `GET /cameras/:id/snapshot` (JPEG) every few seconds (grid 4s, single view 2s) with the bearer
header. **Future enhancement:** real RTSP -> HLS live video once the backend exposes an HLS stream.

## Push

On login the app requests permission, obtains an Expo push token (needs an EAS `projectId` in
`app.json` `extra.eas.projectId`) and calls `registerDevice()` -> `POST /devices {token, platform}`.
**Backend stub:** that endpoint does not exist yet; the call fails soft. Expected push payload data:
`{ "camera_id": "<uuid>", "event_id": 123 }` - tapping opens the camera (or the Events tab).
