# Brick by Brick Reader

**[Open the reader →](https://unsocialism.github.io/brickbybrick/)**

<a href="https://unsocialism.github.io/brickbybrick/"><img src="qr.png" alt="QR code linking to unsocialism.github.io/brickbybrick" width="170" align="right"></a>

Or point your phone's camera at the code to open it there.

A free e-reader for EPUB and PDF books that breaks walls of text into short blocks, so a page
looks like this…

> She thought it was over. It was not over, not remotely.
>
> He came back the following week. The door was unlocked, as it always was.
>
> Nobody in that house had ever believed in locks.

…instead of one solid slab of grey. It was built for reading with **visual snow**, where a dense
page shimmers and the eye keeps losing its line, and it helps with anything else that makes long
paragraphs hard to hold onto. Nothing is rewritten, shortened or summarised — the author's words
are all there, only the spacing changes.

No accounts, no adverts, no tracking, and your books stay on your own device.

## Getting it

**On an Android phone** — open the link above in Chrome, then menu (⋮) → **Add to Home screen**
(or **Install app**, if Chrome offers it). It then behaves like any other app: its own icon,
fullscreen, and it works with no connection.

**On an iPhone or iPad** — open the link in Safari → Share → **Add to Home Screen**. You need
iOS 16.4 or newer. This is less tested than Android; if something misbehaves, do say.

**On a computer** — just use the link. In Chrome or Edge there's an install button in the
address bar if you'd rather have it in its own window.

You only need a connection the first time. After that the reader is stored on the device and
opens in aeroplane mode.

## Adding books

Tap **Add a book** and pick an `.epub` or `.pdf`. You can add several at once.

On Android you can also share a book to the app: in Files, Drive, Dropbox or your browser's
downloads, choose **Share** and pick Brick by Brick Reader.

Books stay on the shelf with your place saved, so you never have to hunt for the file again.
Tap the **⋯** on a book to reset your place in it or remove it.

Where to find books: [Project Gutenberg](https://www.gutenberg.org) (70,000+ free classics),
[Standard Ebooks](https://standardebooks.org) (many of the same books, carefully typeset), or
anything you already own as a file.

## Making it comfortable

Tap **Aa** while reading.

**How the text is broken up**

- *Sentences per block* — how many sentences before a break. Two is the default; one is very
  airy, four is closer to a normal book.
- *Leave paragraphs alone up to* — short paragraphs and dialogue keep the author's shape, so
  conversations aren't chopped into confetti.
- *Break blocks longer than* — one runaway sentence is split at commas and dashes instead of
  becoming a wall on its own.
- *Wider gap where the author's paragraph really ends* — so the real shape of the writing still
  shows through underneath.

**Colour**

Twelve tinted themes, six light and six dark, plus your own colours if none of them fit. There
is no pure white and no pure black anywhere, and a contrast slider softens the text further —
lower contrast usually calms the static.

*Highlight text blocks* gives every block its own tinted panel, with the page colour showing in
the gaps, which separates the blocks more strongly again.

**Type**

Typeface, text size, line spacing, letter and word spacing, how wide the column runs, the gap
between blocks, and ragged or justified edges.

Settings apply to every book; your reading position is kept per book.

## Looking up a word

Select a word the way you normally would and a small **Definition** button appears next to it.
Tap it for the meaning, the part of speech and an example. Word forms are handled, so selecting
*houses*, *believed* or *ran* finds *house*, *believe* and *run*.

At first, definitions come from the internet. In **Aa → Dictionary** you can download the
dictionary onto the device (a few seconds, about 4 MB) — after that lookups work with no
connection and no word ever leaves your phone. The same panel has a switch to turn online
lookups off completely, and to remove the dictionary again.

When a word is looked up online, only that single word is sent. Never the book, never a page of
it, never anything about you.

## PDFs

A PDF has no paragraphs inside it — only letters placed at positions on a page. So when you add
one, the reader works out where every word sits and rebuilds the paragraphs from that, then
treats the result exactly like an EPUB. This happens once, when you add the book, with a page
counter; after that it opens instantly.

It handles running headers and page numbers (removed), words hyphenated across a line break
(rejoined, while real hyphens are kept), chapters from the PDF's own bookmarks, footnote
markers, centred verse, two-column pages and the cover image.

It cannot read **scanned** PDFs — photographs of pages have no text in them at all — and it
refuses encrypted ones. Both say so clearly rather than opening a blank book. Magazines and
textbooks with sidebars and boxes may come out in an odd order; it is built for books and long
prose, where it is very reliable.

## Your books, your device

Everything lives in your browser's own storage on your own device: the books, your reading
positions, your settings. There is no server behind this app and no account to make, so nothing
is uploaded and nothing is shared. The only request the reader ever makes, beyond loading
itself, is that single word sent to a dictionary service when you ask for a definition it
doesn't have on hand — and that can be switched off.

Two consequences worth knowing:

- Nothing syncs between devices. Your phone and your laptop each keep their own shelf.
- If you uninstall the app, or clear site data for the site in your browser settings, the shelf
  goes with it. The app does ask the phone to protect its storage from automatic clean-ups.

## If something isn't right

**A book won't open.** Books from Kindle (`.azw`, `.kfx`) or with Adobe DRM can only be opened
by the shop's own app — that's a lock on the file, not a limitation here. Ordinary `.epub` and
`.pdf` files work.

**It didn't update.** The app updates itself quietly when you open it with a connection, and
tells you when a new version is ready; close it and open it again to get it. On a computer, a
hard refresh (Ctrl+Shift+R) does the same.

**Sentence breaks land in odd places.** Breaks are worked out from punctuation, tuned for
English and German — it knows `Dr.`, `z.B.`, initials like `J. R. R.` and dates like `21. März`.
A very unusual abbreviation can still fool it.

**On a computer:** `←` `→` change chapter, `s` opens settings, `c` contents, `Esc` closes.

Anything else, open an issue on this repository.

---

## Running your own copy

The whole thing is static files — no build step, no server, no dependencies.

| File | What it is |
|---|---|
| `index.html` | The entire app: reader, shelf, settings. |
| `sw.js` | Makes it work offline, keeps it updated, receives shared files. |
| `manifest.webmanifest` | Tells the phone it is installable. |
| `pdf-extract.js` | Rebuilds readable text out of PDFs. Loaded only when a PDF is added. |
| `dict.js` | Word lookup. Loaded only on the first lookup. |
| `dict/en-v1.jsonl.gz` | The offline dictionary (optional — `dict/README.md` explains how to build it). |
| `tools/build-dictionary.py` | Builds that file from WordNet. Never reaches the phone. |
| `icon-*.png` | App icons, including a maskable one for Android's icon shapes. |

Copy the files to any static host served over https — GitHub Pages, Cloudflare Pages, your own
web space. All paths are relative, so a subfolder works as well as a domain root. GitHub Pages
addresses are case-sensitive, so an all-lowercase repository name saves trouble later.

The offline dictionary is built from [WordNet](https://wordnet.princeton.edu) and is the only
optional piece; without it the reader simply looks words up online.
