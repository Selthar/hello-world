#!/usr/bin/env python3
"""Download the media behind your Instagram saved posts.

This reads the ``saved_posts.json`` file from Instagram's official
"Download your information" export, then uses Instaloader (logged in as you)
to download the media + metadata for each saved post to a local folder.

Layout on disk::

    downloads/
      <author_username>/
        <author_username>_<post-date>.jpg
        <author_username>_<post-date>.json.xz   (caption/metadata)

It can also:
  * filter to a single saved *collection* with ``--collection "Name"``
  * write a CSV list of your saved posts (no downloading, no login) with
    ``--csv saved.csv``

Run ``python download_saved.py --help`` for options.

NOTE: automating logged-in access is against Instagram's Terms of Service.
This is intended for pulling *your own* saved data. Be polite with the delay
so you don't get your account rate-limited or temporarily blocked.
"""

from __future__ import annotations

import argparse
import csv
import json
import random
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

try:
    import instaloader
except ImportError:
    instaloader = None  # Only needed for downloading; --csv/--dry-run work without it.


# Instagram post URLs look like /p/<shortcode>/, /reel/<shortcode>/, /tv/<shortcode>/
_POST_PATH_PREFIXES = ("p", "reel", "reels", "tv")
# Matches a shortcode anywhere inside a blob of text/JSON.
_SHORTCODE_RE = re.compile(r"instagram\.com/(?:p|reel|reels|tv)/([A-Za-z0-9_-]+)")


def shortcode_from_url(url: str) -> str | None:
    """Extract the post shortcode from an Instagram permalink, or None."""
    parts = [p for p in urlparse(url).path.split("/") if p]
    if len(parts) >= 2 and parts[0] in _POST_PATH_PREFIXES:
        return parts[1]
    return None


def _first_href_and_timestamp(item: dict) -> tuple[str, int | None]:
    """Pull the post link and (optional) 'saved on' timestamp from an entry."""
    smd = item.get("string_map_data", {})
    for value in smd.values():
        if isinstance(value, dict) and value.get("href"):
            return value["href"], value.get("timestamp")
    return "", None


def parse_saved_export(path: Path) -> list[dict]:
    """Parse saved_posts.json into a list of post records.

    Each record: {shortcode, author, url, saved_on (int|None)}.
    Handles the current Instagram export shape::

        {"saved_saved_media": [
            {"title": "author_username",
             "string_map_data": {"Saved on": {"href": ".../p/CODE/",
                                              "timestamp": 1699999999}}},
            ...
        ]}
    """
    data = json.loads(path.read_text(encoding="utf-8"))
    entries = data.get("saved_saved_media", data) if isinstance(data, dict) else data
    if not isinstance(entries, list):
        raise ValueError(
            f"Unexpected export format in {path}. Expected a 'saved_saved_media' "
            "list from Instagram's saved_posts.json."
        )

    results: list[dict] = []
    for item in entries:
        if not isinstance(item, dict):
            continue
        href, ts = _first_href_and_timestamp(item)
        code = shortcode_from_url(href)
        if code:
            results.append(
                {
                    "shortcode": code,
                    "author": item.get("title") or None,
                    "url": href,
                    "saved_on": ts,
                }
            )
    return results


def collection_shortcodes(path: Path, name: str) -> set[str]:
    """Return the shortcodes belonging to a named saved collection.

    Instagram's collections file has varied in shape over the years, so rather
    than assume an exact schema we find the entry matching ``name`` and then
    scrape every post shortcode out of that entry's raw JSON. If ``name`` is
    not found, raise with the list of collection names we *did* see.
    """
    data = json.loads(path.read_text(encoding="utf-8"))
    entries = data.get("saved_saved_collections", data) if isinstance(data, dict) else data
    if not isinstance(entries, list):
        raise ValueError(
            f"Unexpected collections format in {path}. Expected a "
            "'saved_saved_collections' list."
        )

    def entry_name(entry: dict) -> str:
        if entry.get("title"):
            return entry["title"]
        smd = entry.get("string_map_data", {})
        for key in ("Name", "name"):
            if isinstance(smd.get(key), dict) and smd[key].get("value"):
                return smd[key]["value"]
        return ""

    available = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        this_name = entry_name(entry)
        available.append(this_name)
        if this_name.strip().lower() == name.strip().lower():
            blob = json.dumps(entry)
            return set(_SHORTCODE_RE.findall(blob))

    raise SystemExit(
        f"Collection {name!r} not found in {path}.\n"
        f"Collections found: {', '.join(repr(n) for n in available if n) or '(none)'}"
    )


def load_ledger(path: Path) -> set[str]:
    """Return the set of shortcodes already downloaded (for resumability)."""
    if not path.exists():
        return set()
    return {line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()}


def append_ledger(path: Path, shortcode: str) -> None:
    with path.open("a", encoding="utf-8") as fh:
        fh.write(shortcode + "\n")


def write_csv(path: Path, posts: list[dict], collection: str | None) -> None:
    """Write the saved-post list to a CSV. No login/download required."""
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["author", "shortcode", "url", "date_saved", "collection"])
        for p in posts:
            ts = p.get("saved_on")
            date_saved = (
                datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")
                if ts
                else ""
            )
            writer.writerow(
                [p.get("author") or "", p["shortcode"], p.get("url") or "", date_saved, collection or ""]
            )


def make_loader(outdir: Path) -> "instaloader.Instaloader":
    """Configure Instaloader: folder per author, filename prefixed username_date."""
    return instaloader.Instaloader(
        dirname_pattern=str(outdir / "{target}"),
        filename_pattern="{profile}_{date_utc:%Y-%m-%d_%H-%M-%S}",
        download_video_thumbnails=False,
        download_geotags=False,
        download_comments=False,
        save_metadata=True,
        post_metadata_txt_pattern="",
        quiet=False,
    )


def authenticate(loader: "instaloader.Instaloader", username: str) -> None:
    """Load a saved session if present, otherwise do an interactive login."""
    try:
        loader.load_session_from_file(username)
        print(f"Loaded saved session for @{username}.")
        return
    except FileNotFoundError:
        pass
    print(f"No saved session found for @{username}; logging in interactively.")
    loader.interactive_login(username)  # prompts for password + 2FA
    loader.save_session_to_file()
    print("Login succeeded; session saved for next time.")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Download media for your Instagram saved posts from the official export.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("username", help="Your Instagram username (the logged-in account).")
    parser.add_argument(
        "--export",
        type=Path,
        default=Path("saved_posts.json"),
        help="Path to saved_posts.json from Instagram's data export.",
    )
    parser.add_argument(
        "--collection",
        default=None,
        help="Only include posts from this saved collection (by name).",
    )
    parser.add_argument(
        "--collections-file",
        type=Path,
        default=Path("saved_collections.json"),
        help="Path to the collections file from the export (used with --collection).",
    )
    parser.add_argument(
        "--csv",
        type=Path,
        default=None,
        help="Write a CSV list of the saved posts and exit (no login, no download).",
    )
    parser.add_argument(
        "--outdir",
        type=Path,
        default=Path("downloads"),
        help="Directory to save downloaded media into.",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=12.0,
        help="Base seconds to wait between posts (jittered +/-40%%) to avoid rate limits.",
    )
    parser.add_argument(
        "--rest-every",
        type=int,
        default=20,
        help="Take a longer rest after this many posts (0 = never).",
    )
    parser.add_argument(
        "--rest-seconds",
        type=float,
        default=90.0,
        help="How long the longer rest lasts.",
    )
    parser.add_argument("--limit", type=int, default=0, help="Only process the first N posts (0 = all).")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Parse the export and show what would be downloaded, without logging in.",
    )
    args = parser.parse_args()

    if not args.export.exists():
        sys.exit(
            f"Export file not found: {args.export}\n"
            "Get it from Instagram: Settings -> Accounts Center -> Your information and "
            "permissions -> Download your information (choose JSON). Look for saved_posts.json."
        )

    posts = parse_saved_export(args.export)
    if not posts:
        sys.exit("No saved posts with valid post links were found in the export.")

    # Optional: restrict to a single collection.
    if args.collection:
        if not args.collections_file.exists():
            sys.exit(
                f"Collections file not found: {args.collections_file}\n"
                "It comes with the same export as saved_posts.json. Point --collections-file at it."
            )
        wanted = collection_shortcodes(args.collections_file, args.collection)
        posts = [p for p in posts if p["shortcode"] in wanted]
        if not posts:
            sys.exit(f"No saved posts matched collection {args.collection!r}.")
        print(f"Filtered to collection {args.collection!r}: {len(posts)} posts.")

    # CSV mode: write the list and stop. No login, nothing downloaded.
    if args.csv:
        write_csv(args.csv, posts, args.collection)
        print(f"Wrote {len(posts)} rows to {args.csv}.")
        return 0

    args.outdir.mkdir(parents=True, exist_ok=True)
    ledger_path = args.outdir / ".downloaded.txt"
    failures_path = args.outdir / "failures.log"
    done = load_ledger(ledger_path)

    pending = [p for p in posts if p["shortcode"] not in done]
    if args.limit > 0:
        pending = pending[: args.limit]

    print(
        f"Found {len(posts)} saved posts; {len(done)} already downloaded; "
        f"{len(pending)} to process this run."
    )

    if args.dry_run:
        for p in pending:
            who = p["author"] or "?"
            print(f"  would download {p['shortcode']} (author: {who})")
        return 0

    if instaloader is None:
        sys.exit(
            "Instaloader is not installed, so downloading is unavailable. Run:\n"
            "    pip install -r requirements.txt\n"
            "(--csv and --dry-run work without it.)"
        )

    loader = make_loader(args.outdir)
    authenticate(loader, args.username)

    ok = 0
    failed = 0
    for i, entry in enumerate(pending, start=1):
        code = entry["shortcode"]
        print(f"[{i}/{len(pending)}] {code} ...", flush=True)
        try:
            post = instaloader.Post.from_shortcode(loader.context, code)
            # target = author's username -> one folder per author.
            loader.download_post(post, target=post.owner_username)
            append_ledger(ledger_path, code)
            ok += 1
        except Exception as exc:  # noqa: BLE001 - keep going on any single-post error
            failed += 1
            msg = f"{code}\t{type(exc).__name__}: {exc}"
            print(f"    FAILED: {msg}", file=sys.stderr)
            with failures_path.open("a", encoding="utf-8") as fh:
                fh.write(msg + "\n")

        if i < len(pending):
            if args.rest_every and i % args.rest_every == 0:
                print(f"    resting {args.rest_seconds:.0f}s to stay under the radar ...")
                time.sleep(args.rest_seconds)
            else:
                time.sleep(args.delay * random.uniform(0.6, 1.4))

    print(f"\nDone. Downloaded {ok}, failed {failed}.")
    if failed:
        print(f"See {failures_path} for the failures; re-running will retry them.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
