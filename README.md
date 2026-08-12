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
   `saved_posts.json` file with a permalink for every post you've saved.
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
Download your information**. Request an export in **JSON** format. When it
arrives, find `saved_posts.json` inside and put it next to this script (or
point `--export` at it).

### Step 2 — Run it

```bash
python download_saved.py YOUR_INSTAGRAM_USERNAME
```

The first run prompts for your password (and 2FA if enabled) once, then saves
a session file so later runs don't ask again.

### Options

| Flag | Default | Purpose |
|------|---------|---------|
| `--export` | `saved_posts.json` | Path to the export file |
| `--outdir` | `downloads` | Where media is saved |
| `--delay` | `6.0` | Base seconds between posts (jittered) to avoid rate limits |
| `--limit` | `0` | Only process the first N posts (0 = all) — good for a test run |
| `--dry-run` | off | Show what would be downloaded without logging in |

**Resumable:** already-downloaded posts are recorded in
`downloads/.downloaded.txt` and skipped, so you can stop and restart safely.
Failures are logged to `downloads/failures.log` and retried on the next run.

### Please read

- Automating logged-in access is **against Instagram's Terms of Service.**
  This is meant for pulling *your own* saved data. Keep `--delay` reasonable so
  you don't get rate-limited or temporarily blocked.
- Run it on **your own computer** — it needs your login session and your
  export file, neither of which belong in a shared/cloud environment.
- Your export, downloaded media, and session file are git-ignored so they're
  never accidentally committed.
