# Minimal New Tab

A clean, minimal new tab page for Chrome. Blank by default, with an optional bookmark grid that follows your system
theme.

[中文文档](README.zh-CN.md)

## Features

- Blank by default — no news, no widgets, no clutter
- Optional bookmark grid, off by default
- Folder-grouped icon cards
- Icon-only display, hover for title
- 15 icons collapsed, 31 expanded
- `+N more` hint for folders with more than 31 bookmarks
- Follows system light / dark mode
- Auto-scales to fit the viewport — never scrolls
- Live updates when bookmarks change

## Install

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the project folder.

## Setup

Make Chrome open this page on startup:

1. Go to `chrome://settings/onStartup`
2. Choose **Open the New Tab page**

Hide Chrome's native bookmarks bar (optional, recommended):

1. Go to `chrome://settings/appearance`
2. Set **Show bookmarks bar** to **Never**

## Usage

Open a new tab. The page is blank by default.

To show bookmarks:

1. Move your mouse to the bottom-right corner.
2. Click the gear icon.
3. Turn on **Bookmarks**.

Bookmarks bar folders appear as cards. Click `+N` on a card to expand it.

## Permissions

- **`bookmarks`** — read your bookmark bar to render the cards
- **`favicon`** — fetch site icons via Chrome's local favicon service
- **`storage`** — remember your settings

## License

MIT