# X Bookmark Media Saver — Chrome Extension

Automatically detects and saves images, videos, and GIFs from your X (Twitter) bookmarks as you browse them. No login credentials required — runs entirely in your browser.

Files are named `@handle_YYYY-MM-DD_tweetid.ext`, so they sort by author and post date.

---

## Installation (takes ~1 minute)

Since this is a custom extension (not on the Chrome Web Store), you load it in **Developer Mode**:

1. **Open Chrome Extensions page**
   - Go to `chrome://extensions/` in your address bar, OR
   - Menu → More Tools → Extensions

2. **Enable Developer Mode**
   - Toggle the "Developer mode" switch in the top-right corner

3. **Load the extension**
   - Click **"Load unpacked"**
   - Navigate to and select the `x-bookmark-saver` folder (the folder containing `manifest.json`)
   - Click "Select Folder"

4. **Done!** The extension icon (blue square) will appear in your toolbar.
   - Pin it for easy access: click the puzzle piece icon → pin X Bookmark Media Saver

---

## How to Use

1. **Go to your X Bookmarks**
   - Visit [x.com/i/bookmarks](https://x.com/i/bookmarks)
   - Or click the extension icon → click the "X Bookmarks" link in the empty state

2. **Scroll through your bookmarks**
   - The extension silently detects images, videos, and GIFs as they load on screen
   - A badge count on the extension icon shows how many items are queued

3. **Open the extension popup**
   - Click the extension icon in your toolbar
   - You'll see all detected media listed with thumbnails

4. **Download**
   - Click **"Download All"** to save everything in the queue
   - Or click the individual download button (↓) next to any item
   - Files are saved to your Downloads folder under `X-Bookmarks/Images/` and `X-Bookmarks/Videos/`

5. **Batch over time**
   - Scroll more bookmarks → more media gets detected → download again
   - Already-downloaded items are tracked so you won't re-download duplicates
   - The queue persists even when the popup is closed

---

## File Organization

"Download All" produces a single zip in your Downloads folder:

```
X-Bookmarks-2026-08-19_01.zip
├── Images/
│   ├── @someartist_2024-03-20_1780000000000000001.jpg
│   └── @someartist_2024-03-20_1780000000000000001_1.png
└── Videos/
    └── @someposter_2024-01-05_1780000000000000002.mp4
```

The name carries the poster's handle and the date they posted, followed by the
tweet ID. Tweets with several images get a trailing index. When a bookmarked
retweet is saved, the handle and date belong to whoever originally posted the
media, not the person who retweeted it.

Downloading a single item with the ↓ button writes it straight to
`X-Bookmarks/Images/` or `X-Bookmarks/Videos/` instead of a zip.

---

## How It Works

The extension reads the same JSON your browser already receives when it loads
your bookmarks, rather than scraping the page's HTML. That response carries the
handle, post date, full-resolution image URLs, and direct MP4 video URLs, so
detection does not break when X changes its markup — which is what broke
earlier versions.

Videos are saved as the highest-bitrate MP4 X offers, with audio intact. A
small number of clips (mostly live broadcasts) have no MP4 version; those fall
back to stitching HLS segments and may be video-only.

---

## Tips

- **Scroll slowly** to give the extension time to detect media in each tweet
- **GIFs** (which X serves as MP4 files) are saved in the Videos folder
- If a download **fails**, try clicking the individual retry button — it may be a temporary network issue
- The **"Rescan"** button re-checks the current page for any media that might have been missed
- Use the **filter tabs** (Queued / All / Downloaded / Failed) to review your queue

---

## Privacy & Security

- **No login required** — the extension reads media that your browser has already loaded
- **No data sent anywhere** — everything runs locally in your browser
- **No API keys** — uses Chrome's built-in download API
- The extension only activates on `x.com` and `twitter.com` pages

---

## Troubleshooting

**Nothing is detected:**
- Reload the bookmarks page after installing or updating the extension. The
  extension has to be running *before* the page requests your bookmarks.
- Scroll down to load more bookmarks — each batch is captured as it loads.

**Items are skipped:**
- Anything downloaded before is remembered and not queued twice. Settings →
  "Clear download history" makes them eligible again.

**Un-bookmarking looks like it did nothing:**
- Check X itself before assuming it failed. Tweets that were off screen are
  removed through the API, which X's page does not notice until it reloads.
  The extension hides those rows for you, but the count in X's own UI can stay
  stale until you refresh.
- Keep the X tab open and stay on the bookmarks page — removals go through the
  page so they carry your session.
- If you see "Bookmark API details not captured yet", reload the bookmarks page
  and wait a few seconds before retrying.

**A video downloaded without sound:**
- That clip had no MP4 version and fell back to HLS. Open the tweet directly to
  save it manually.

---

## Compatibility

- Chrome 88+ (Manifest V3)
- Edge 88+ (Chromium-based)
- Brave (Chromium-based)

*Note: Firefox requires a different manifest format and is not currently supported.*
