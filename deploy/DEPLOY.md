# Deploying for free (no card)

| Part | Where | Address |
|---|---|---|
| Source code | GitHub, public repo `server-city` | `github.com/yashasvi16/server-city` |
| Website (3D city, resume, game) | Cloudflare Pages: free, no card, unlimited bandwidth | `https://yashasvi-rathore.pages.dev` |
| Go backend (live visitors, guestbook, leaderboard, stats) | Render free web service: free, no card | `https://yashasvi-city-api.onrender.com` |
| Nicer address (later) | is-a.dev: free | `https://yashasvi.is-a.dev` |

**What the free backend means in practice:**

- **It sleeps.** The backend sleeps after 15 minutes with no visitors and takes about a minute to wake. While it wakes, the site says **"Waking the server…"** and runs in demo mode. It switches to **Live** by itself when the server answers.
- **Data resets.** The guestbook and leaderboard are kept in memory and on a temporary disk, so they reset whenever Render restarts or sleeps the server.
- **Monthly limits.** Render gives 750 free hours a month, enough to run one service around the clock. Outbound bandwidth is capped (the third-party guide below gives 5 GB a month), which is plenty for this backend: the heavy 3D files come from Cloudflare. If a limit is ever hit, Render pauses the backend until the next month and the site keeps working in demo mode.

If a name below is taken (repo, Render service, Pages project), pick another and tell me. Only the backend address is built into the site, so only that one needs a rebuild.

---

## A. Put the code on GitHub (5 minutes)

GitHub Desktop is the easiest way on Windows.

1. Install GitHub Desktop from <https://desktop.github.com> and sign in as `yashasvi16`.
2. **File → Add local repository →** choose `D:\Golang\server-city\server-city`. When it says "this directory does not appear to be a Git repository", click **create a repository**.
   - Name: `server-city`. Leave "Initialize with README" off.
   - Click **Create repository**.
3. Check the left panel before committing. It should **not** list `node_modules`, `dist`, `release` or `backend/data`; the `.gitignore` files exclude them. Then click **Commit to main**.
4. Click **Publish repository** and **untick "Keep this code private"**. Public code is a plus here: the site links to it.

Before publishing, delete the old `Makefile` and rename `Makefile.new` to `Makefile`, and delete the three stub files listed in my earlier message (`filler.ts`, `island.ts`, `plinths.ts`).

## B. Backend on Render (10 minutes, mostly build time)

1. Go to <https://render.com> and sign up with **GitHub**. No card is asked for.
2. Click **New → Blueprint** and pick the `server-city` repo. Render reads `render.yaml` from the repo and creates **yashasvi-city-api** with every setting filled in: free plan, Singapore region, Go build, health check, environment variables, and a generated secret for game tokens.
3. Click **Apply** and wait for the deploy log to say **Live**.
4. Check two pages:
   - <https://yashasvi-city-api.onrender.com/api/stats> should show a line of JSON.
   - <https://yashasvi-city-api.onrender.com/api/whoami> shows `"ip"`. It should be **your** public IP (compare with <https://www.whatismyip.com>). If it's different, send me what the page shows: it means Render's proxies differ from what their community threads describe, and the per-visitor rate limits would need one setting changed.

If Blueprint is unavailable, create the service by hand: **New → Web Service →** the repo, with these settings:

| Setting | Value |
|---|---|
| Name | `yashasvi-city-api` |
| Region | Singapore |
| Root Directory | `backend` |
| Runtime | Go |
| Build Command | `go build -trimpath -ldflags "-s -w" -o app ./cmd/server` |
| Start Command | `./app` |
| Instance Type | **Free** |
| Health Check Path (Advanced) | `/api/health` |
| Environment variables | `ADDR=:10000`, `DATA_DIR=/tmp/server-city`, `ALLOWED_ORIGINS=https://yashasvi-rathore.pages.dev,https://yashasvi.is-a.dev`, `CLIENT_IP_HEADER=X-Forwarded-For:1`, `RUN_SECRET=` (click **Generate**) |

## C. Website on Cloudflare Pages (5 minutes)

1. Go to <https://dash.cloudflare.com> and sign up. It's free and needs no card.
2. Click **Workers & Pages → Create → Pages → Connect to Git** and pick `server-city`.
3. Build settings:

   | Setting | Value |
   |---|---|
   | Project name | `yashasvi-rathore` |
   | Production branch | `main` |
   | Framework preset | None |
   | Root directory | `frontend` |
   | Build command | `npm ci && npm run build` |
   | Build output directory | `dist` |
   | Environment variables | `VITE_API_BASE=https://yashasvi-city-api.onrender.com`, `NO_PRECOMPRESS=1`, `NODE_VERSION=22` |

4. Click **Save and Deploy** and wait about 2 minutes. Then open <https://yashasvi-rathore.pages.dev>. The top bar shows "Waking the server…", then **Live**.

From now on, every push to GitHub redeploys both the website and the backend automatically.

**No-Git fallback for the website:** choose **Pages → Upload assets** instead of Connect to Git, and drag in the `release/site` folder. It's already built with the Render address.

## D. Optional: keep the backend awake

The free plan sleeps after 15 minutes without requests. A free uptime pinger, such as <https://cron-job.org> or UptimeRobot, can request `https://yashasvi-city-api.onrender.com/api/health` every 10 minutes. That keeps it awake around the clock: about 744 hours a month, inside the 750 free hours. That means no wake-up wait for visitors, and the guestbook lasts until Render's next restart.

Render can still restart free services at any time, and keeping one awake uses up the month's free hours. This step is optional and your call.

## E. `yashasvi.is-a.dev`, once the site is live

is-a.dev is run by volunteers, and they review requests by hand. Their rules ask you to write the request yourself: AI-generated requests get rejected.

1. Read <https://docs.is-a.dev>.
2. Fork <https://github.com/is-a-dev/register> and add `domains/yashasvi.json` with a **CNAME** to `yashasvi-rathore.pages.dev`, following their format.
3. Open the pull request and watch it in case they ask for changes.
4. Once it's merged, go to **Pages → yashasvi-rathore → Custom domains** and add `yashasvi.is-a.dev`.

The backend already accepts requests from that address.

## Updating later

Edit, commit and push in GitHub Desktop. Render and Cloudflare both redeploy on their own.

## Troubleshooting

| Symptom | Check |
|---|---|
| Stuck on "Waking the server…" or "Demo mode" | Open `…onrender.com/api/stats`. The first request after sleep takes about a minute. If it errors, check **Render → yashasvi-city-api → Logs**. |
| Stats page works but the site never goes Live | The site's address must be listed in `ALLOWED_ORIGINS` exactly (no trailing slash). Fix it in **Render → Environment**; it redeploys by itself. |
| Pages build fails | Make sure **Root directory** is `frontend` and `NODE_VERSION=22`. Then read the build log. |

## Always-on alternative (needs a card)

`deploy/gcp/setup.sh` sets up the same backend on a Google Cloud free-tier VM behind Caddy, with HTTPS, swap and daily backups. It doesn't sleep and keeps data. It's kept here in case you want it later.

Sources on the free tiers: [Render: Deploy for Free](https://render.com/docs/free), [Render changelog: WebSocket messages keep free services awake](https://render-web.onrender.com/changelog/free-web-services-now-remain-active-while-receiving-websocket-messages), [Free hosting reference, Sept 2026](https://snapdeploy.dev/state-of-free-hosting).
