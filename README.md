# Brick by Brick Reader — installable EPUB and PDF reader

An EPUB and PDF reader that breaks walls of text into short blocks, with low-contrast tinted
themes. Everything runs in the browser: no server, no accounts, no tracking, and your
books never leave your phone.

Once installed it works with the phone in aeroplane mode.

## What's in here

| File | What it is |
|---|---|
| `index.html` | The whole app — reader, library, settings. No libraries or frameworks. |
| `manifest.webmanifest` | Tells Android this is an installable app (name, icon, colours). |
| `sw.js` | Service worker: makes the app work offline, keeps it updated, receives shared files. |
| `pdf-extract.js` | Reads the text out of PDFs and rebuilds the paragraphs. Loaded only when you add a PDF. |
| `dict.js` | Word lookup: the offline dictionary and the online fallback. Loaded the first time you look a word up. |
| `dict/en-v1.jsonl.gz` | The offline dictionary itself (optional — see **Word lookup** below). |
| `tools/build-dictionary.py` | Builds that file from WordNet. Not part of the app; it never reaches the phone. |
| `icon-*.png` | App icons, including a maskable one for Android's adaptive icon shapes. |

All paths are relative, so it works at a domain root **or** in a subfolder
(`https://you.github.io/your-repo/`) with no changes.

## Putting it on your phone

Android will only install a web app served over **https**, so the folder has to live
somewhere on the web first. Any static host works. Two easy free ones:

### GitHub Pages (no command line needed)

1. Create a free account at github.com, then **New repository** → give it a name (all
   lowercase is easiest; the address is case-sensitive) → **Public** → Create.
2. On the empty repo page, click **uploading an existing file**, then drag in all the
   files from this folder (the files themselves, not the folder). Click **Commit changes**.
3. Go to **Settings → Pages**. Under *Branch* pick `main` and `/ (root)`. Save.
4. Wait about a minute, then reload that page — it shows your URL, something like
   `https://yourname.github.io/your-repo/`.

### Cloudflare Pages

1. Sign in at pages.cloudflare.com → **Create a project** → **Direct Upload**.
2. Drag this folder in. It gives you a `https://….pages.dev` URL straight away.

### Then, on the phone

1. Open that URL in **Chrome**.
2. Menu (⋮) → **Add to Home screen** — or **Install app**, if Chrome offers it.
3. Open it from the home screen. It runs fullscreen, with no address bar.
4. Tap **Add a book** and pick an `.epub` or `.pdf`. You can also share one to Brick by Brick Reader
   from Files, Drive or your browser's downloads — the app appears in the share sheet.

After the first visit the app is cached, so it opens and reads with no connection.
Updating later means re-uploading the files and reopening the app once online.

## Reading settings

Tap **Aa**.

- **Sentences per block** — how many sentences before a break. Default 2.
- **Leave paragraphs alone up to** — paragraphs this short keep the author's shape,
  so dialogue isn't chopped up. Default 3 sentences.
- **Break blocks longer than** — a single runaway sentence is split at commas, dashes
  and semicolons so it can't become a wall on its own. Default 35 words.
- **Colour** — twelve tinted themes plus custom colours, and a contrast slider that
  softens text against the background. No pure white or pure black anywhere.
- **Highlight text blocks** — gives each block its own tinted background, with the page colour
  showing between blocks. The tint follows the theme; a slider sets how strong it is, and you
  can pick your own colour instead.
- **Type** — typeface, size, line spacing, letter and word spacing, column width,
  gap between blocks, ragged or justified.
- **Dictionary** — whether the **Definition** button appears when you select a word, whether
  unknown words may be looked up online, and the offline dictionary itself.

Settings apply to every book; your place is remembered per book.

## Word lookup

Select a word in the book the way you normally would, and a small **Definition** button
appears next to it. Tapping it opens a panel with the definitions, the part of speech and
an example sentence. Word forms are handled, so selecting *houses*, *believed* or *ran*
finds *house*, *believe* and *run*.

Two layers answer the lookup, in this order:

1. **The offline dictionary on the phone.** Downloaded once from *Aa → Dictionary →
   Download the offline dictionary*, then kept in the phone's own storage. After that,
   lookups work in aeroplane mode and no word ever leaves the device.
2. **An online dictionary** (`api.dictionaryapi.dev`), asked only when a word is not in
   layer 1, and only while *Look words up online* is switched on. Only the single word is
   sent — never the book, never a page of it. Answers are kept on the phone, so the same
   word works offline afterwards. Switch it off to keep everything local.

If neither layer has the word, the panel says so rather than guessing.

### Adding the offline dictionary file

The app works without it — lookups just use the internet. To add it:

1. Download **WNdb-3.0.tar.gz** from <https://wordnet.princeton.edu/download/current-version>
   (about 10 MB — WordNet, from Princeton, freely redistributable).
2. Run `python3 tools/build-dictionary.py WNdb-3.0.tar.gz`. It writes
   `dict/en-v1.jsonl.gz` (roughly 4 MB for 147,000 words) and prints what it built.
3. Upload the `dict` folder to the repo next to `index.html`.

The phone then downloads that one file when the reader asks for it and unpacks it into
its own storage — a few seconds, with a progress line, and only once. The download itself
is never cached twice: *Aa → Dictionary* shows what is installed and can remove it again.

`--senses 2` and `--no-examples` make a smaller file if you want one.

## Sharing it

The page is public — anyone with the address can open it and use the reader, and it is
free to install on their own phone the same way.

Each person gets their own private shelf. Books, reading position and settings live in
that person's own browser storage on their own device and are never uploaded: the app has
no server, no accounts and no analytics. The only request it ever makes beyond loading its
own files is a single word sent to a dictionary service when someone asks for a definition
the phone doesn't have — and that can be switched off. So sharing the link shares the
reader, never anyone's library.

## PDFs

A PDF isn't really text — it's letters placed at positions on a page, with no paragraphs in
it. So when you add one, the app reads where every word sits and rebuilds the paragraphs from
that: line spacing, first-line indents, the short last line of a paragraph. Then it feeds the
result into the same reader as an EPUB, so blocks, colours and spacing all work the same way.

This happens once, when you add the PDF (a 400-page book takes a few seconds, with a
page counter). After that it opens instantly, and it works offline, including adding new PDFs.

What it handles:

- **Running headers and page numbers** are recognised and removed.
- **Words hyphenated across lines** are rejoined. Real hyphens (`south-westerly`) are kept:
  the app looks at how the rest of the document spells the word, and at whether the PDF
  hyphenates automatically at all (typeset books do; Word and browser exports don't).
- **Chapters** come from the PDF's bookmarks; if it has none, from the chapter headings.
- **Italics, footnote markers** (shown as ¹ ²), **centred verse and epigraphs** (kept line by line),
  **two-column pages** (read left column first), and the **cover** if the first page has one.

What it can't do:

- **Scanned PDFs** — photos of pages — have no text inside them. Reading those would need
  text recognition, which this app doesn't do. You'll get a clear message rather than a blank book.
- **Encrypted PDFs** are refused, again with a message saying so.
- **Heavily designed layouts** — magazines, textbooks with sidebars and boxes — may come out
  in an odd order. It's built for books and long prose, where it's very reliable.

The original page layout isn't shown: the app only ever shows the reflowed text. If a PDF
is mostly diagrams or tables, a normal PDF viewer is the better tool for that one.

## Things worth knowing

- **DRM'd books won't open.** Files from Kindle (`.azw`, `.kfx`) or with Adobe DRM can
  only be read by the vendor's own app. Brick by Brick Reader reads ordinary `.epub` and `.pdf` files.
- **Your library lives in this browser's storage on this phone.** Uninstalling the app
  or clearing site data for the domain deletes it. The app asks Android for persistent
  storage so it isn't cleared automatically, but nothing syncs between devices.
- **Sentence detection is heuristic**, tuned for English and German. It knows about
  `Dr.`, `z.B.`, `bzw.`, initials like `J. R. R.` and dates like `am 21. März`. A very
  unusual abbreviation could occasionally cause a break in the wrong place.
- **The text is never rewritten** — only split. Nothing is added, removed or reordered.
- **Looking a word up online is the one network request the app ever makes**, it happens
  only when you ask for a definition the phone doesn't have, and it can be switched off.

## Keyboard (if you ever use it on a desktop)

`←` `→` chapters · `s` settings · `c` contents · `Esc` close
