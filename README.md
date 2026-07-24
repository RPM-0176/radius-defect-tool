# Radius Defect Checklist — setup guide

> **Already have this deployed?** You only need to do this: on GitHub, in
> your `radius-defect-tool` repo, replace `index.html` and update the
> `netlify` folder so it contains all three function files
> (`submit-inspection.js`, `review.js`, `my-reports.js`) — drag the whole
> `netlify` folder in as one object so the structure stays correct. Then
> Netlify → Deploys → Trigger deploy. Your existing environment variables
> and `reports/team-keys.json` don't need to change.

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
  and the `netlify` folder with all three files inside `netlify/functions/`:
  `submit-inspection.js`, `review.js`, and `my-reports.js`)
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
| `REVIEW_SECRET` | a passphrase — give this only to whoever is allowed to approve reports (you, and any other PM/compliance sign-off person) |

You do **not** need a `SUBMIT_SECRET` variable for a new setup — team access is now managed per-person, in a file, not a shared passphrase (see Step 5a below). `SUBMIT_SECRET` still works as a legacy fallback if you'd already set one and haven't issued individual keys yet, but there's no need to add it fresh.

### Step 5a — issue each team member their own key

Instead of one password for the whole team, each person gets their own — so you know exactly who submitted what, and can cut off one person's access without touching anyone else's.

1. In your **`radius-defect-records`** repo (the data repo, not the tool repo), create a new file: **Add file → Create new file**
2. Name it exactly: `reports/team-keys.json` (typing the folder with a slash creates it automatically)
3. Paste in something like this, one entry per person, making up a unique key for each:

```json
{
  "keys": [
    { "name": "MG", "key": "radius-mg-7391", "active": true },
    { "name": "Seb", "key": "radius-seb-4820", "active": true },
    { "name": "Julie", "key": "radius-julie-1156", "active": true }
  ]
}
```

4. Commit to `main`

Give each person **only their own key** — e.g. text MG just `radius-mg-7391`, nothing else. They paste it into "Your personal access key" on the tool, once.

**To revoke someone's access:** edit this same file, set their `"active"` to `false` (or delete their whole entry), and commit. It takes effect on their very next submission — no redeploy needed, since the function reads this file fresh every time.

**To add someone new:** add another entry to the list, same way.

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
- The site URL — everyone gets this
- Each person's **own individual key** from `team-keys.json` — send each
  person only their own, not the whole list. They paste it into "Your
  personal access key" once, on their own device.

Separately, give the **`REVIEW_SECRET`** only to whoever should be approving
reports (you, and anyone else who does sign-off). They paste it into
"Manager review key" once, on their own device, and leave "Your personal
access key" blank unless they also do inspections themselves.

Everyone opens the same URL — the keys just control what each person can see
and do, and every submission is now tied to whoever's key was used, visible
in the review queue and in `reports/index.csv`.

## How the whole loop works day to day

1. Inspector finishes on site, taps **"Send to central record."** Filed as **Pending review**, tied to their own key.
2. You open **"Review queue"** with `REVIEW_SECRET`, tap **View PDF**, then **Approve** or **Request changes**.
3. The inspector opens **"My submissions"** on their own phone (same personal key they submitted with) — it shows only their own reports and current status.
4. Once you've approved it, a **"Download approved PDF"** button appears for that report. They tap it, the file lands on their phone, and they attach it to an email/text to the client themselves.
5. If a report isn't approved yet, that button simply isn't there — the file can't be pulled out early, even if someone guesses the internal job code. If you sent it back for changes, they see your note and can fix it up and resubmit under the same job.

This means nothing reaches a client until you've actually looked at it and approved it — enforced by the system, not just by habit — while the inspector still does the actual sending themselves, same as before.

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
