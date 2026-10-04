# Deploying Margin (invite-only, on a VPS)

This guide puts Margin on your own domain, e.g. `https://paper.example.com`. Only people you invite can sign in, with their GitHub account. Plan on about an hour, most of it waiting for the first build.

What runs on the server (`deploy/docker-compose.yml`):

| Service | What it does |
|---|---|
| `caddy` | HTTPS for your domain (free Let's Encrypt certificate, renewed automatically) and security headers |
| `server` | Margin: web app, API, live editing, git remote, AI, Margin Connect relay |
| `compile` | The LaTeX sandbox (TeX Live): no internet, read-only, non-root, CPU and memory capped |

Everything is stored in one Docker volume, `margin_data`: projects (as git repos), membership, encrypted API keys and review history.

---

## 1. Get a server

Any Linux VPS works. Recommended: **Ubuntu 24.04 LTS, 2 vCPU, 4 GB RAM, 40 GB disk**. Examples: Hetzner CPX21, DigitalOcean 4 GB, Vultr or Lightsail, about $6–24 a month. TeX Live alone takes about 6 GB of disk. Use 8 GB of RAM if many people compile at once.

## 2. Point your domain at it

At your DNS provider, add an **A record**, e.g. `paper` → the server's IPv4 address (and an AAAA record for IPv6 if it has one). Wait until `ping paper.example.com` shows the right IP.

## 3. Prepare the server

SSH in as root (or a sudo user) and run:

```sh
apt update && apt upgrade -y
# Firewall: SSH, HTTP (needed for the certificate) and HTTPS only
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
# Docker
curl -fsSL https://get.docker.com | sh
```

## 4. Put the code on the server

On your Mac, push the repository to a **private** GitHub repo, once:

```sh
cd ~/Developer/margin
git remote add origin git@github.com:YOUR-USER/margin.git
git push -u origin main
```

On the server:

```sh
git clone https://github.com/YOUR-USER/margin.git /opt/margin   # use a deploy key or token for a private repo
cd /opt/margin
```

## 5. Create the GitHub sign-in app

GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**:

- **Homepage URL**: `https://paper.example.com`
- **Authorization callback URL**: `https://paper.example.com/api/auth/github/callback`

Copy the **Client ID**, then click **Generate a new client secret** and copy that too.

## 6. Configure

```sh
cp .env.example .env
chmod 600 .env
nano .env
```

Fill in:

```sh
MARGIN_DOMAIN=paper.example.com
MARGIN_SECRET=          # run: openssl rand -hex 32   (keep it; see the note below)
MARGIN_ADMINS=your-github-login            # invite-only; comma-separate several admins
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
COMPILE_TOKEN=          # run: openssl rand -hex 16
TEXLIVE_IMAGE=texlive/texlive:latest-full
# Optional:
ANTHROPIC_API_KEY=      # a shared Claude key for members without their own (usually leave empty)
CROSSREF_MAILTO=you@example.com   # faster citation checks
```

`MARGIN_SECRET` signs sessions **and encrypts members' stored Anthropic API keys**. If you change it, everyone has to sign in again and re-enter their API key.

## 7. Start it

```sh
docker compose -f deploy/docker-compose.yml --env-file .env up -d --build
docker compose -f deploy/docker-compose.yml logs -f server     # Ctrl+C to stop watching
```

The first build downloads TeX Live and takes 10–20 minutes. When the log shows `margin server on :8787 (… invite-only)`, open **https://paper.example.com**.

## 8. Sign in and invite your group

1. Click **Continue with GitHub**. You're an admin because your login is in `MARGIN_ADMINS`.
2. On the projects page, open **Members & invites** and click **Create invite link**. Choose how many people it's for and when it expires.
3. Send each person their link. They open it, sign in with GitHub, and they're in.

Removing a member there takes effect immediately, including their git and agent tokens.

## 9. Bring your existing papers

Pick one way per paper:

- **Zip:** compress the paper's folder, then **New paper → Import existing → Overleaf or .zip**. The main file and engine are detected automatically, even in a subfolder like `LaTeX/main.tex`.
- **Git:** if the paper is a public repository, **Import existing → Git repository**.

## 10. Use your own Claude Code or Codex (optional)

On each laptop, create a token in Margin → **Local**, then run:

```sh
npx -y margin-connect --url https://paper.example.com --token mgn_…
# until margin-connect is published to npm:
node ~/Developer/margin/packages/connect/dist/index.js --url https://paper.example.com --token mgn_…
```

Then, in a project, choose your agent under **✦ Assistant**, or under **Review → Run with** for subscription reviews.

---

## Updating

```sh
cd /opt/margin
git pull
docker compose -f deploy/docker-compose.yml --env-file .env up -d --build
```

Live documents are saved when the server stops, so an update doesn't lose anyone's typing. Expect a few seconds of reconnecting.

## Backups

All data lives in the `margin_data` volume. Run this daily (e.g. as a cron job at 03:00):

```sh
mkdir -p /root/backups
docker run --rm -v margin_data:/data:ro -v /root/backups:/backup alpine \
  tar czf /backup/margin-$(date +%F).tgz -C /data .
find /root/backups -name 'margin-*.tgz' -mtime +14 -delete     # keep two weeks
```

Copy the backups off the server too, e.g. with `rclone` to Backblaze B2 or Google Drive. Each project is also a full git repository, so anyone with a clone holds a copy of the paper's history.

**To restore:**

```sh
docker compose -f deploy/docker-compose.yml down
docker run --rm -v margin_data:/data -v /root/backups:/backup alpine sh -c "rm -rf /data/* && tar xzf /backup/margin-YYYY-MM-DD.tgz -C /data"
docker compose -f deploy/docker-compose.yml --env-file .env up -d
```

## Security notes

- **Who can get in:** invite-only, with GitHub sign-in; the shared password is disabled when `MARGIN_ADMINS` is set. Sessions are signed HttpOnly, Secure, SameSite cookies, write requests must come from your own site, and membership is checked on every request.
- **Compiling:** every compile runs in the `compile` container. It has no internet access, a read-only filesystem and no shell escape, it can't read absolute or parent paths, and it is limited to 2 CPUs, 2 GB and 90 seconds.
- **Keep secret:** `.env` (chmod 600). Never commit it.
- **Before opening sign-ups to the public:** run each compile in its own container or gVisor sandbox, and add per-user storage quotas, abuse reporting and monitoring.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Browser warns about the certificate | DNS doesn't point at the server yet, or port 80 is blocked. Check `docker compose -f deploy/docker-compose.yml logs caddy`. |
| GitHub says "redirect_uri is not associated" | The OAuth app's callback must be exactly `https://YOUR-DOMAIN/api/auth/github/callback`. |
| "Margin here is invite-only" | Expected for people without an invite. Admins must be in `MARGIN_ADMINS` (GitHub login, case doesn't matter). |
| Compile says "service is not reachable" | Check `docker compose -f deploy/docker-compose.yml ps`, then `logs compile`. |
| A LaTeX package is missing | Use `TEXLIVE_IMAGE=texlive/texlive:latest-full`, then rebuild. |
| Margin Connect can't connect | Use the `https://` URL and a fresh token, and check that the person is still a member. |
