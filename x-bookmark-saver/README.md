# X Bookmark Media Saver — Chrome Extension

Automatically detects and saves images, videos, and GIFs from your X (Twitter) bookmarks as you browse them. No login credentials required — runs entirely in your browser.

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

Downloaded files are saved to your default Downloads folder:

```
Downloads/
└── X-Bookmarks/
    ├── Images/
    │   ├── FxA3kP2WYAEz8Kl.jpg
    │   └── ...
    └── Videos/
        ├── 1234567890.mp4
        └── ...
```

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

**"Cannot reach page" error when scanning:**
- Refresh the bookmarks page and try again
- Make sure you're on `x.com/i/bookmarks` (not just `x.com`)

**Videos not detected:**
- Some videos require the tweet to be fully loaded — try clicking into individual tweets
- Twitter's video URLs sometimes change; if a download fails, opening the tweet directly may help

**Extension not detecting anything:**
- Make sure you're on the bookmarks page (`/bookmarks` in the URL)
- Scroll down to load more tweets — the extension detects media as it appears on screen
- Click "Rescan" in the popup after scrolling

---

## Compatibility

- Chrome 88+ (Manifest V3)
- Edge 88+ (Chromium-based)
- Brave (Chromium-based)

*Note: Firefox requires a different manifest format and is not currently supported.*
