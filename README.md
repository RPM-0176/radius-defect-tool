# Radius Defect Checklist — setup guide

This folder is everything needed to host the checklist tool at a real web
address, with every submitted report automatically filed into a central
GitHub repo you can browse any time.

You only do this setup once. Your team never touches GitHub or Netlify —
they just open a link on their phone.

---

## What you're building

```
Team member's phone  --->  your Netlify site (the tool)
                              |
                              |  "Send to central record"
                              v
                        Netlify serverless function
                              |
                              |  writes files via GitHub's API
                              v
                  radius-defect-records  (GitHub repo — your central file store)
                        reports/<job-slug>/defect-report.pdf
                        reports/<job-slug>/summary.json
                        reports/index.csv   <- running ledger of every job, open in Excel
```

The GitHub write-access token lives only on Netlify's servers — it's never
sent to anyone's phone. Your team instead uses one shared passphrase, so
random visitors can't push junk into your repo.

---

## Step 1 — Create two GitHub repos

1. **`radius-defect-records`** — leave this completely empty. This is your
   central file location. Every submitted report lands here.
2. **`radius-defect-tool`** — this holds the code in this folder (the
   website + the function that talks to GitHub).

Both can be private repos — that's recommended, since reports may contain
participant-related site photos.

## Step 2 — Push this code into `radius-defect-tool`

Easiest way, no command line needed:
- Open the empty `radius-defect-tool` repo on github.com
- Click **Add file → Upload files**
- Drag the entire contents of this folder in (`index.html`, `netlify.toml`,
  and the `netlify` folder with `functions/submit-inspection.js` inside it)
- Commit directly to `main`

(If you're comfortable with git, the usual `git init / add / commit / push`
works too.)

## Step 3 — Generate a GitHub access token

This is what lets the function write into `radius-defect-records` on your
behalf.

1. GitHub → your profile photo → **Settings → Developer settings → Personal
   access tokens → Fine-grained tokens → Generate new token**
2. **Repository access:** "Only select repositories" → choose
   `radius-defect-records` only
3. **Permissions:** Repository permissions → **Contents: Read and write**
   (leave everything else as No access)
4. Generate, then **copy the token straight away** — GitHub only shows it once

## Step 4 — Deploy the site on Netlify

1. Netlify → **Add new site → Import an existing project**
2. Connect to GitHub, choose the **`radius-defect-tool`** repo
3. Build settings can be left blank/default — there's nothing to build,
   Netlify will just publish `index.html` and pick up the function
   automatically from `netlify.toml`
4. Deploy

Optional: in **Site settings → Domain management**, change the auto-generated
name to something memorable, e.g. `radius-checklist.netlify.app`.

## Step 5 — Add the environment variables

**Site settings → Environment variables** on the Netlify site, add:

| Key | Value |
|---|---|
| `GITHUB_TOKEN` | the token from Step 3 |
| `GITHUB_OWNER` | your GitHub username or org |
| `GITHUB_REPO` | `radius-defect-records` |
| `GITHUB_BRANCH` | `main` (only needed if your default branch is named differently) |
| `SUBMIT_SECRET` | make up a passphrase — this is what you'll give your whole team |
| `REVIEW_SECRET` | make up a **different** passphrase — give this one only to whoever is allowed to approve reports (you, and any other PM/compliance sign-off person) |

Then **trigger a redeploy** (Deploys tab → Trigger deploy) so the function
picks up the new variables.

## Step 6 — Test it

1. Open your Netlify site URL
2. Paste your `SUBMIT_SECRET` into the **"Central record key"** box
3. Fill in a test project name, mark one item as a Defect, tap
   **"Send to central record"**
4. You should see "Sent — central record updated". Check
   `radius-defect-records` on GitHub — you'll see a new `reports/<slug>/`
   folder with the PDF, plus `reports/index.csv` with a new row, and a
   `reports/registry.json` with one "pending" entry.
5. Now paste `REVIEW_SECRET` into the **"Manager review key"** box (only
   you should have this one) and tap **"Review queue"** — you should see
   that same test report listed as "Pending review", with buttons to
   **View PDF**, **Approve**, or **Request changes**. Try approving it and
   confirm the status updates.

## Step 7 — Hand it to the team

Share two different things:
- The site URL, and the **`SUBMIT_SECRET`** — give this to everyone doing
  inspections, to paste into "Central record key" once (it's remembered on
  that device after that)
- The **`REVIEW_SECRET`** — give this only to whoever should be approving
  reports (you, and anyone else who does sign-off). They paste it into
  "Manager review key" once, on their own device, and leave the ordinary
  "Central record key" box blank unless they also do inspections themselves.

Everyone opens the same URL — the two keys just control what each person can
see and do.

## How the review queue works day to day

1. Inspector finishes on site, taps **"Send to central record."** The report
   is filed with status **Pending review**.
2. You (or whoever holds the review key) open **"Review queue"** whenever
   convenient — it lists every pending report: project, inspector, date,
   defect counts.
3. Tap **View PDF** to read it, then **Approve** or **Request changes**
   (optionally with a note — the inspector will need to be told separately,
   e.g. by message, since this doesn't send notifications on its own).
4. Approved reports are marked accordingly in the registry. You still attach
   the PDF and email the client yourself — this feature's job is only to
   make sure nothing gets that far without you having actually looked at it.

---

## A couple of things worth knowing

- **Photo-heavy inspections:** the PDF upload has to fit in one request.
  Compressed photos are tiny (roughly 100–300KB each) so this comfortably
  covers a typical inspection, but a job with an unusually large number of
  defect photos (several dozen) could hit the size ceiling. If that happens,
  the tool will show an error and the inspection stays safely saved on the
  device — use "Email defect report (PDF)" for that one instead, or let me
  know and I'll add chunked uploads.
- **The ledger (`reports/index.csv`)** is a lightweight summary for quickly
  scanning what's come in (project, defect counts, date) — the actual full
  record with notes and photos is the PDF sitting next to it in the same
  folder.
- **Changing the passphrase later** just means updating `SUBMIT_SECRET` in
  Netlify and telling the team the new one.
