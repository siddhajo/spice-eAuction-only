# Deploying into a customer's own Railway account

> How to let each customer run Spice e-Auction on **their own Railway account,
> billed to their own card**, while you keep a single GitHub account and a
> single private repo.
>
> Read [CUSTOMER-ONBOARDING.md](CUSTOMER-ONBOARDING.md) Step 1 for where this
> fits in the onboarding flow, and [LICENSING.md](LICENSING.md) for the license
> machinery this document keeps referring to.

**Last reviewed:** 2026-09-01

---

## 1. The constraint you can't design around

When you sign in to Railway with GitHub, **your Railway account *is* your GitHub
identity**. One GitHub login maps to exactly one Railway user. There is no way to
create a second Railway account from the same GitHub account, and no setting that
"links" one GitHub account to several Railway accounts.

So the literal question — *link one GitHub account to multiple Railway accounts* —
has no answer. Fortunately it isn't the actual requirement. The actual requirement
is:

> **The same private repo must be deployable into N separate Railway accounts,
> each paying its own bill.**

That is very achievable. Three routes below, then the recommended one in detail.

---

## 2. The three routes at a glance

| | **A — You're invited in** | **B — Image + template** | **C — They deploy from GitHub** |
|---|---|---|---|
| Railway account owner | Customer | Customer | Customer |
| Who pays Railway | Customer | Customer | Customer |
| Who clicks deploy | You | Customer (one click) | Customer |
| Your GitHub repo | Stays private, you keep sole access | Stays private | **Customer needs collaborator access** |
| Extra Railway cost | Pro workspace + a paid seat for you | None | None |
| Shipping an update | You redeploy | Customer redeploys, or you trigger via API | Customer redeploys |
| Onboarding effort | High (per customer, manual) | Low (send a link) | Medium |
| Verdict | For hand-held customers | **Default** | Only if the deal is source-available |

Route C hands over your source. Don't take it unless that's the commercial
agreement — every other row is achievable without it.

---

## 3. Read this before you pick: what "the customer owns it" actually costs you

Moving a customer from *your* Railway account to *theirs* changes the security
picture, and it's better to know now than to discover it later.

**Whoever owns the Railway service can read everything inside it.** They can open
the Variables tab, add a service, open a shell, and read the container's
filesystem. Concretely, once a customer owns the deployment:

1. **They can read your source.** This is a Node app — the image ships `server.js`
   and every `*.js` module as plain text. No amount of registry privacy changes
   this, because the customer must be able to *run* the container.
2. **They can read `LICENSE_SECRET`.** It's an environment variable on their
   service. With it and [tools/license-sign.js](tools/license-sign.js) — or twenty
   lines of their own HMAC code, since the token format is documented in
   [LICENSING.md §1](LICENSING.md#1-how-it-works) — they can mint their own
   renewal tokens indefinitely.

[LICENSING.md](LICENSING.md#threat-model) already states the threat model as
"honest-customer protection only; anyone with the source can patch the gate out."
That was always true, but while *you* held the Railway account the customer had no
practical route to either the source or the secret. Customer-owned accounts remove
that practical barrier.

**What to do about it — pick one, deliberately:**

- **Accept it.** The license gate keeps honest customers renewing on time; the
  contract handles the rest. This is the pragmatic choice for a small, known
  customer base, and it's the assumption the rest of this document is written
  under.
- **Use a distinct `LICENSE_SECRET` per customer.** You should be doing this
  regardless. It means a leaked secret compromises exactly one customer, not the
  whole fleet. Record each one against the customer name.
- **Move verification server-side** if the exposure ever matters commercially:
  have the app call a licensing endpoint you host instead of verifying an HMAC
  locally. That's a real code change to [license.js](license.js), out of scope
  here, but it's the only fix that actually survives customer-owned hosting.

Route A (you stay the operator inside their workspace) does **not** avoid any of
this — a workspace owner can still read variables and shell into services.

---

## 4. Route B — GHCR image + Railway template (recommended)

The customer clicks one link, Railway provisions the whole thing into their
account on their card, and you never touch their dashboard.

### 4.1 Publish the image

[.github/workflows/publish-image.yml](.github/workflows/publish-image.yml) builds
[Dockerfile](Dockerfile) and pushes to the GitHub Container Registry.

```bash
# Cut a release — builds the image AND (via the existing android-apk workflow)
# the APK from the same tag.
git tag v1.1.0
git push origin v1.1.0
```

Or run it by hand from **Actions → Publish Docker image (GHCR) → Run workflow**
and type a tag like `dev` or `1.1.0-rc1` for a test build.

Resulting tags:

| You push | Image tags produced |
|---|---|
| tag `v1.1.0` | `1.1.0`, `1.1`, `latest` |
| manual run, input `dev` | `dev` only (never `latest`) |

The image lands at `ghcr.io/<your-github-owner>/spice-eauction`. No secret to
configure — the workflow authenticates with the automatic `GITHUB_TOKEN`.

> The workflow builds `linux/amd64` only. That's what Railway runs. Adding arm64
> would emulate the Chromium `apt-get` layer under QEMU and roughly triple build
> time for no benefit.

### 4.2 First publish only: make the package pullable

GHCR packages are created **private**. A private image means every customer's
Railway service needs registry credentials, which is friction you probably don't
want. Go to **github.com/&lt;owner&gt; → Packages → spice-eauction → Package
settings** and choose:

- **Public** — anything can `docker pull` it, no credentials anywhere. Simplest,
  and the only option that makes a one-click template genuinely one-click.
  Remember §3: this makes your source readable by the public, not just by
  customers.
- **Private** — you then give each customer's Railway service a fine-grained
  GitHub token with `read:packages`, pasted into the service's registry
  credentials. Keeps the code away from the open internet. It does **not** keep
  it away from the customer, who can pull the image with that same token.

Whichever you choose, also connect the package to this repo (Package settings →
"Manage Actions access") so future workflow runs can push new versions to it.

### 4.3 Create the Railway template

Railway templates are authored in the Railway dashboard, not in this repo — there
is no template file to commit. In your own Railway account:

**New → Template** (or railway.com/new/template) → add a service → set its source
to a **Docker image**: `ghcr.io/<owner>/spice-eauction:latest`.

Then configure the service *inside the template* as follows. Getting these three
things right is the whole job:

**a) A persistent volume — non-negotiable.**

Mount path: `/app/data`

Without it, every redeploy wipes `data/config.db`, which means the customer loses
all their data *and* their `install_id` resets to a fresh 30-day trial. This is
the single most common way to break a Spice deployment. See
[LICENSING.md §2 Step 3](LICENSING.md#step-3--attach-a-persistent-volume).

**b) Variables.**

| Variable | Template setting | Notes |
|---|---|---|
| `LICENSE_SECRET` | **Required input**, no default | Per-customer. You generate it and give it to them, or you fill it in for them — see 4.5. A default here would hand every customer the same secret. |
| `SPICE_DATA_DIR` | Fixed value `/app/data` | Must match the volume mount path above. |
| `ADMIN_BRANDING_KEY` | Optional input | Protects `/admin/branding`. Let Railway generate a random value rather than shipping a default. |
| `PORT` | **Leave unset** | Railway injects it; [server.js:21034](server.js#L21034) reads `process.env.PORT` and falls back to 3001. |

**c) Health check.** Point it at a path the app serves once it's up. Railway will
otherwise mark slow first boots as failed while sql.js initialises.

Give the template a name, a description, and an icon, then publish it. Railway
also runs a kickback program that pays template authors a share of the usage
their template generates — worth reading the current terms on their site if
you're publishing to the public marketplace rather than sharing the link
privately.

### 4.4 Hand the customer the button

The template's share panel gives you a URL and a ready-made markdown snippet
along the lines of:

```markdown
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template/XXXXXX)
```

Copy the snippet Railway shows you rather than hand-writing the URL — the button
asset path has changed across Railway's rebrand and the template code is
generated per template.

The customer's flow from there: click → sign in / sign up for Railway (their
email, their card) → fill the inputs → Deploy. They end up as the sole owner of a
project in their own account.

### 4.5 Who fills in `LICENSE_SECRET`?

Two workable patterns; pick one and stay consistent:

- **You generate, they paste.** Run the generator from
  [LICENSING.md §2 Step 1](LICENSING.md#step-1--generate-a-signing-secret), send
  the value over a channel you trust, and have them paste it into the deploy
  form. Record it against the customer.
- **They deploy, you fill it in.** They deploy with a placeholder, then add you
  to the project briefly so you can set the real value in Variables. Slower, but
  the secret never travels through the customer's inbox.

Either way, **record the secret and the resulting `install_id` in your renewal
log** — you cannot mint a renewal token later without both. The install id is
printed in the boot log and available at `/api/license/status`.

### 4.6 Shipping updates to customers who already deployed

This is the real cost of Route B, and it's worth being clear-eyed about it: a
template deploy is a **snapshot**. Pushing `v1.2.0` to GHCR does not move anyone.
Existing services keep running the digest they pulled at deploy time, even if
they're nominally tracking `:latest`.

To get an update onto a live customer:

- **Ask them to redeploy.** Their Railway project → the service → Deploy. One
  click for them, zero access for you. Fine for a handful of customers on a
  monthly cadence.
- **Trigger it yourself via the Railway API.** Ask the customer once for a
  Railway API token scoped to their project; store it against the customer and
  call the redeploy mutation when you ship. Turns updates into something you run,
  not something you chase.
- **Pin versions instead of `latest`** if a customer needs to stay on a known
  build — deploy them from `ghcr.io/<owner>/spice-eauction:1.1.0` and move them
  deliberately.

Whichever you choose, say it explicitly at handover so the customer knows whether
updates arrive automatically (they don't) or on request.

---

## 5. Route A — you get invited into the customer's workspace

Use this when the customer wants to own the bill but wants you to run everything.

1. Customer signs up for Railway with their own email and payment method.
2. They create a workspace and **upgrade it to Pro** — member seats are a paid
   feature; a personal/Hobby workspace can't have other members.
3. They invite your Railway account as a member.
4. You switch into their workspace and deploy **from your own GitHub
   connection** — your Railway user carries its own GitHub App installation, so
   the private repo is available to you inside their workspace without them ever
   gaining repo access.

**What to know going in:**

- **The seat costs money** (per-member, per-month on Pro — check Railway's
  current pricing). The customer pays it. Multiply by every customer you onboard
  this way.
- **The deploy source is tied to you.** If you leave the workspace or your GitHub
  link breaks, the customer cannot rebuild the service — they have no repo
  access. Route B has no such dependency, because the image is self-contained.
- **§3 still applies in full.** Being the operator doesn't stop the workspace
  owner reading variables or shelling into the container.
- Set the same variables and volume as §4.3 — the requirements are identical, you
  just click them in by hand instead of having a template do it.

---

## 6. Route C — the customer deploys from GitHub themselves

For a customer's Railway account to build from your repo, that customer's GitHub
user needs read access to the repo, because each Railway user deploys through
their own GitHub App installation. There is no way to grant "Railway account X
may build repo Y" without granting a human access to Y.

That means adding a customer as a collaborator on the private repo — handing over
the source, permanently and copyably, to someone who could fork it the same day.

Take this route only where source-available is the agreed commercial terms. If
you do, give them their own fork rather than collaborator access on your working
repo, so their deployments never track your `main`.

---

## 7. Moving an existing customer off your Railway account onto theirs

You currently host every customer as a service in your own Railway account. Those
customers have live data in `data/config.db`, and Railway volumes cannot be
transferred between accounts. Use the app's own backup/restore — this is exactly
what it's for.

1. **Freeze.** Tell the customer to stop entering data. Anything entered after the
   backup is taken will be lost in the switch.
2. **Back up the old deployment.** As an admin, hit `GET /api/system/backup` — it
   flushes pending sql.js writes and streams the live `config.db` down as
   `spice-eauction-backup-<stamp>.db`. Keep this file until the switch is signed
   off.
3. **Stand up the new deployment** in the customer's account (Route B or A).
   **Set `LICENSE_SECRET` to the same value the old deployment used** — see the
   note below on why.
4. **Restore.** Log in to the new deployment as admin and `POST` the backup file
   to `/api/system/restore`.
5. **Verify before cutting over.** Log in, open the last invoice the customer
   generated and check the number and totals match; run one export; confirm
   Settings shows the right GSTIN, bank and logo. The logo lives in the data
   volume and is rehydrated into `public/` on boot, so a successful restore
   brings the branding with it.
6. **Cut over.** Point the customer at the new URL, take a final backup of the
   old service, then delete it from your account so you stop paying for it.

> **Why the secret must match.** `license_state` — including `install_id` — lives
> inside `config.db` ([LICENSING.md §1](LICENSING.md#state)). Restoring the backup
> carries the customer's original install id and expiry into the new deployment,
> so their existing renewal tokens keep working and their paid-up period isn't
> reset to a fresh trial. That only holds if `LICENSE_SECRET` is identical on the
> new deployment; with a different secret, every previously issued token fails
> signature verification.
>
> Corollary: the install id **does not change** when you migrate, so your renewal
> log stays valid. Don't re-record it as a new customer.

---

## 8. Troubleshooting

**Customer's deploy fails pulling the image.**
The GHCR package is still private. Either make it public (§4.2) or give the
service registry credentials.

**Customer redeployed and lost all their data.**
No volume, or the volume is mounted somewhere other than `SPICE_DATA_DIR`. Check
that the mount path and the variable both say `/app/data`. Restore from the most
recent backup — `GET /api/system/backups` lists the automatic snapshots, if the
volume survived.

**App boots but the trial restarted at 30 days.**
Same root cause: it wrote a fresh `license_state` because `config.db` wasn't
there. Fix the volume first, *then* restore, otherwise you'll do it twice.

**Boot log warns `LICENSE_SECRET env var is not set`.**
The template input was left blank and [license.js](license.js#L39) fell back to
the dev-only secret. Tokens you mint will not verify. Set the real value and
redeploy.

**Renewal token rejected with "bad signature" after a migration.**
`LICENSE_SECRET` differs between the old and new deployment. Set the new one to
the old value (§7).

**A new customer's PDFs show the previous customer's logo.**
The image is built from the repo, and per-deployment logos are deliberately kept
out of it ([.gitignore](.gitignore)) — so this means a stale `config.db` came
along in a restore. Start that deployment from an empty volume instead.
