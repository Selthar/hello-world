# hello-world

This is my first repository

I know enough HTML and CSS to get in trouble. I'm hoping to polish up those skills and learn Javascript, PHP, and Swift.

---

## Instagram Saved-Posts Downloader

`download_saved.py` downloads the media behind your Instagram **saved** posts
(your bookmarks) to a local folder, using Instagram's official data export as
the list of what to fetch.

### How it works

1. **Instagram gives you the list.** The official export contains a
   `saved_posts` file with a permalink for every post you've saved.
2. **The script downloads the media.** It reads that file and, logged in as
   you, uses [Instaloader](https://instaloader.github.io/) to download each
   post's media + metadata — throttled and resumable.

Files land as one **folder per post author**, with each filename prefixed by
the author's username and the post date:

```
downloads/
  nasa/
    nasa_2023-11-14_09-30-00.jpg
    nasa_2023-11-14_09-30-00.json.xz
  natgeo/
    natgeo_2023-11-15_12-00-00.mp4
```

### Setup

```bash
pip install -r requirements.txt
```

### Step 1 — Get your saved-posts list from Instagram

Instagram → **Settings → Accounts Center → Your information and permissions →
Download your information**. Either export format works:

- **JSON** — cleanest for the collection filter and CSV metadata.
- **HTML** — also fully supported. The script auto-detects the format from the
  file extension.

When the export arrives, find the `saved` folder inside it (it contains
`saved_posts.*` and `saved_collections.*`) and point `--export` at the
`saved_posts` file.

### Step 2 — Verify the parse first (no login, no downloads)

Before downloading anything, confirm the script reads your export correctly:

```bash
# See which posts it found (and the authors it detected):
python download_saved.py YOUR_USERNAME --export saved_posts.html --dry-run

# See which collections it detected:
python download_saved.py YOUR_USERNAME --export saved_posts.html --list-collections
```

Neither command logs in or downloads anything.

### Step 3 — Download

```bash
# A one-post test run first:
python download_saved.py YOUR_USERNAME --export saved_posts.html --limit 1

# The full run:
python download_saved.py YOUR_USERNAME --export saved_posts.html
```

The first download prompts for your password (and 2FA if enabled) once, then
saves a session file so later runs don't ask again.

### Options

| Flag | Default | Purpose |
|------|---------|---------|
| `--export` | `saved_posts.json` | Path to your saved-posts file (`.json` or `.html`) |
| `--collection` | — | Only download posts from this saved collection (by name) |
| `--collections-file` | sibling of `--export` | Path to `saved_collections.*` |
| `--list-collections` | off | List detected collections and exit (no login) |
| `--csv` | — | Write a CSV list and exit (no login, no download) |
| `--outdir` | `downloads` | Where media is saved |
| `--delay` | `12.0` | Base seconds between posts (jittered) to avoid rate limits |
| `--rest-every` | `20` | Take a longer rest after this many posts (0 = never) |
| `--rest-seconds` | `90.0` | How long that longer rest lasts |
| `--limit` | `0` | Only process the first N posts (0 = all) — good for a test run |
| `--dry-run` | off | Show what would be downloaded without logging in |

The CSV columns are `author, shortcode, url, date_saved, collection`.

**Resumable:** already-downloaded posts are recorded in
`downloads/.downloaded.txt` and skipped, so you can stop and restart safely.
Failures are logged to `downloads/failures.log` and retried on the next run.

### A note on export formats

The post **links** (what the downloader actually needs) are read reliably from
either format — the author folder name and post date come from Instagram at
download time, not from the export. The **collection filter** and the CSV's
author/date columns are read cleanly from JSON and best-effort from HTML, so
run `--list-collections` and `--dry-run` first to confirm they look right.

### Please read

- Automating logged-in access is **against Instagram's Terms of Service.**
  This is meant for pulling *your own* saved data. Keep `--delay` reasonable so
  you don't get rate-limited or temporarily blocked.
- Run it on **your own computer** — it needs your login session and your
  export file, neither of which belong in a shared/cloud environment.
- Your export, downloaded media, and session file are git-ignored so they're
  never accidentally committed.
