# Deploying the OCR web app (Render free tier)

The app goes online as a single Docker container that serves both the API and the
built React app, gated behind **Sign in with Google** with a hard email allowlist.
All data stays in Neon (Postgres), so the host holds no state — migrating to
another host later is mostly re-entering env vars.

## Who can do what

The app has **two tiers**, enforced server-side on every `/api` route (not just
in the UI):

| | Anonymous | Guest (any Google account) | Member (`ALLOWED_EMAILS`) |
| --- | --- | --- | --- |
| Reach any `/api` route | ✗ `401` | ✓ | ✓ |
| Browse the library, read transcriptions and page scans | ✗ | ✓ | ✓ |
| Compare pre-computed sentiment scores and download them | ✗ | ✓ | ✓ |
| Edit pages, tags, splits, book titles | ✗ | ✗ `403` | ✓ |
| Anything that calls Claude (OCR, quality checks, LLM scoring) | ✗ | ✗ `403` | ✓ |
| Run or batch any scoring, load lexicons, define dimensions | ✗ | ✗ `403` | ✓ |
| Connect Google Drive | ✗ | ✗ `403` | ✓ |

**This means your deployment is publicly readable once it ships.** Anyone who can
sign in with Google sees the whole corpus. Nothing they can do spends Anthropic
credits or changes stored data — every endpoint that does either is member-only —
but the content itself is exposed by design.

Roles are derived from `ALLOWED_EMAILS` on **every request**, never stored in the
session cookie. Cookies last seven days, so a cached role would keep a removed
account privileged for up to a week; deriving it means adding or removing an
address takes effect on the very next request, with no redeploy and no re-login.

## What protects your API credits

No endpoint that reaches Anthropic is available below the member tier, and there
is no path from a guest session to one. Verify both boundaries locally any time:

```bash
npm run test:access
```

That boots the server and hits every route as anonymous, guest and member,
checking each lands in the right tier — and that promoting/demoting an address
takes effect on the same session token. Add a case there whenever you add a
route. The older gate check covers just the anonymous boundary:

```bash
npx tsx scripts/test-auth-gate.ts
```

## One-time prerequisites

- The GitHub repo (already: `Father-Pumpkin/ocr`).
- Your Neon `DATABASE_URL`.
- Your `ANTHROPIC_API_KEY`.
- Your existing Google OAuth client (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`).
- A session secret: `openssl rand -hex 32`

## Steps

### 1. Push the code
Commit and push to GitHub (Render deploys from the repo).

### 2. Create the Render service
- Render dashboard → **New → Web Service** → connect the GitHub repo.
- **Runtime: Docker** (Render auto-detects the `Dockerfile`).
- Instance type: **Free**.
- Health check path: `/api/health`.
- Create it. Render assigns a URL like `https://ocr-xxxx.onrender.com` — note it.

### 3. Set environment variables (Render → Settings → Environment)

| Variable | Value |
|---|---|
| `DATABASE_URL` | your Neon connection string |
| `ANTHROPIC_API_KEY` | your Anthropic key |
| `GOOGLE_CLIENT_ID` | existing OAuth client id |
| `GOOGLE_CLIENT_SECRET` | existing OAuth client secret |
| `GOOGLE_DRIVE_FOLDER_ID` | your Drive folder id |
| `SESSION_SECRET` | the `openssl rand -hex 32` value |
| `ALLOWED_EMAILS` | *(optional)* who gets **full** access; everyone else who signs in is a read-only guest. Overrides the baked-in default (`mitchellornesmith@gmail.com,jamesahs@umich.edu`) |
| `BASE_URL` | the `https://ocr-xxxx.onrender.com` URL (no trailing slash) |
| `GOOGLE_DRIVE_TOKEN` | *(optional)* contents of `credentials/oauth-token.json`, one line |

`NODE_ENV=production` is baked into the image, which turns the gate on. If any of
the required vars are missing the server **fails fast at boot** with a clear log
message (better than silently running open) — so set them before the first deploy.

### 4. Point Google at the deployed URL
In Google Cloud Console → **APIs & Services → Credentials → your OAuth client**:
- Add an **Authorized redirect URI**:
  `https://ocr-xxxx.onrender.com/api/auth/google/callback`
- On the **OAuth consent screen**, if the app is in *Testing* mode, add both your
  and James's Google accounts under **Test users** (otherwise Google blocks the
  sign-in before our allowlist even runs). Scopes are non-sensitive
  (`openid email profile`), so no Google verification is required.

### 5. Deploy & sign in
- Trigger a deploy (Render does this on push, or use **Manual Deploy**).
- Open the URL → **Sign in with Google** → pick an account → you're in.
- An account on `ALLOWED_EMAILS` gets the full app. Any other account gets the
  read-only guest view, marked with a "Guest" badge in the header.

## Cold start (free tier)
The service sleeps after ~15 min idle and takes ~a minute to wake. The app shows a
"Waking up the server…" banner and retries automatically, so the first load after
idle is slow, not broken.

## Optional: custom domain
Point e.g. `ocr.yourdomain.com` at the Render service, then set `BASE_URL` to it and
add `https://ocr.yourdomain.com/api/auth/google/callback` to the Google client.
After that, switching hosts is just a DNS change — no Google/login reconfig.

## Moving to Railway later
Same Docker image, same repo, same Neon DB. Create the Railway service from the
repo, copy the env vars over, and update `BASE_URL` + the Google redirect URI to
the new URL (or skip that entirely if you used a custom domain). ~15 minutes, no
code changes.

## Local auth testing
Auth is off in local dev by default. To exercise the real gate locally, set in `.env`:

```
AUTH_ENABLED=1
SESSION_SECRET=<anything>
BASE_URL=http://localhost:5173
ALLOWED_EMAILS=you@gmail.com
```

and add `http://localhost:5173/api/auth/google/callback` to the Google client's
redirect URIs.
