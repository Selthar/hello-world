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

Run ``python download_saved.py --help`` for options.

NOTE: automating logged-in access is against Instagram's Terms of Service.
This is intended for pulling *your own* saved data. Be polite with the delay
so you don't get your account rate-limited or temporarily blocked.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

try:
    import instaloader
except ImportError:
    sys.exit(
        "Instaloader is not installed. Run:\n"
        "    pip install -r requirements.txt\n"
        "(or: pip install instaloader)"
    )


# Instagram post URLs look like /p/<shortcode>/, /reel/<shortcode>/, /tv/<shortcode>/
_POST_PATH_PREFIXES = ("p", "reel", "reels", "tv")


def shortcode_from_url(url: str) -> str | None:
    """Extract the post shortcode from an Instagram permalink, or None."""
    parts = [p for p in urlparse(url).path.split("/") if p]
    if len(parts) >= 2 and parts[0] in _POST_PATH_PREFIXES:
        return parts[1]
    return None


def parse_saved_export(path: Path) -> list[dict]:
    """Parse saved_posts.json into a list of {shortcode, author} dicts.

    Handles the current Instagram export shape::

        {"saved_saved_media": [
            {"title": "author_username",
             "string_map_data": {"Saved on": {"href": ".../p/CODE/", ...}}},
            ...
        ]}

    ``title`` (the author's username) may be absent for some entries; in that
    case ``author`` is None and Instaloader fills it in from the post itself.
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
        smd = item.get("string_map_data", {})
        href = ""
        for value in smd.values():
            if isinstance(value, dict) and value.get("href"):
                href = value["href"]
                break
        code = shortcode_from_url(href)
        if code:
            results.append({"shortcode": code, "author": item.get("title") or None})
    return results


def load_ledger(path: Path) -> set[str]:
    """Return the set of shortcodes already downloaded (for resumability)."""
    if not path.exists():
        return set()
    return {line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()}


def append_ledger(path: Path, shortcode: str) -> None:
    with path.open("a", encoding="utf-8") as fh:
        fh.write(shortcode + "\n")


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
        "--outdir",
        type=Path,
        default=Path("downloads"),
        help="Directory to save downloaded media into.",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=6.0,
        help="Base seconds to wait between posts (jittered +/-40%%) to avoid rate limits.",
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
            wait = args.delay * random.uniform(0.6, 1.4)
            time.sleep(wait)

    print(f"\nDone. Downloaded {ok}, failed {failed}.")
    if failed:
        print(f"See {failures_path} for the failures; re-running will retry them.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
