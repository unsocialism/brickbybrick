#!/usr/bin/env python3
"""
Build the offline dictionary file for Brick by Brick Reader.

Input : the WordNet 3.0 database files (data.noun, index.noun, noun.exc, ...),
        either as the downloaded tarball or as an unpacked folder.
        https://wordnet.princeton.edu/download/current-version  (WNdb-3.0.tar.gz)
Output: dict/en-v1.jsonl.gz  — one JSON value per line, gzipped:

        {"v":1,"name":"WordNet 3.0","license":"...","built":"2026-09-23"}
        ["abandon",[["v","to leave behind"],["n","a total lack of inhibition"]]]
        ...
        {"exc":{"ran":"run","mice":"mouse"}}

Usage:
    python3 tools/build-dictionary.py WNdb-3.0.tar.gz            # -> dict/en-v1.jsonl.gz
    python3 tools/build-dictionary.py /path/to/dict-folder -o out.jsonl.gz
    python3 tools/build-dictionary.py WNdb-3.0.tar.gz --senses 2 --no-examples

WordNet is distributed under its own permissive licence; keep the LICENSE file
from the download next to the output so the terms travel with the data.
"""
import argparse, gzip, io, json, os, re, sys, tarfile, datetime

POS_FILES = [('noun', 'n'), ('verb', 'v'), ('adj', 'a'), ('adv', 'r')]


def read_sources(path):
    """Return {filename: text} for the WordNet files we need, from a tarball or a folder."""
    want = set()
    for name, _ in POS_FILES:
        want |= {'data.' + name, 'index.' + name, name + '.exc'}
    out = {}
    if os.path.isdir(path):
        for root, _dirs, files in os.walk(path):
            for f in files:
                if f in want:
                    with open(os.path.join(root, f), 'rb') as fh:
                        out[f] = fh.read().decode('utf-8', 'replace')
    else:
        with tarfile.open(path, 'r:*') as tf:
            for m in tf.getmembers():
                base = os.path.basename(m.name)
                if m.isfile() and base in want:
                    out[base] = tf.extractfile(m).read().decode('utf-8', 'replace')
    missing = want - set(out)
    if missing:
        sys.exit('Could not find these WordNet files in %s:\n  %s' % (path, ', '.join(sorted(missing))))
    return out


def parse_data(text):
    """data.<pos> -> {offset: (definition, example)}"""
    out = {}
    for line in text.splitlines():
        if not line or line.startswith('  '):
            continue
        off, _, rest = line.partition(' ')
        if not off.isdigit() or '|' not in rest:
            continue
        gloss = rest.split('|', 1)[1].strip()
        # gloss is: definition; "an example"; "another one"
        parts = re.split(r';\s*(?=")', gloss)
        definition = parts[0].strip().rstrip(';').strip()
        example = ''
        for p in parts[1:]:
            p = p.strip().strip(';').strip()
            if p.startswith('"'):
                example = p.strip('"').strip()
                break
        if definition:
            out[off] = (definition, example)
    return out


def parse_index(text):
    """index.<pos> -> [(lemma, [offsets in sense order])] preserving file order"""
    rows = []
    for line in text.splitlines():
        if not line or line.startswith('  '):
            continue
        f = line.split()
        if len(f) < 6:
            continue
        lemma = f[0]
        try:
            p_cnt = int(f[3])
        except ValueError:
            continue
        offsets = [x for x in f[4 + p_cnt + 2:] if x.isdigit()]
        if offsets:
            rows.append((lemma, offsets))
    return rows


def parse_exc(text):
    out = {}
    for line in text.splitlines():
        f = line.split()
        if len(f) >= 2 and f[0] != f[1]:
            out.setdefault(f[0].replace('_', ' '), f[1].replace('_', ' '))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('source', help='WNdb-3.0.tar.gz, or a folder holding the WordNet dict files')
    ap.add_argument('-o', '--out', default=os.path.join('dict', 'en-v1.jsonl.gz'))
    ap.add_argument('--senses', type=int, default=3, help='senses kept per word and part of speech (default 3)')
    ap.add_argument('--no-examples', action='store_true', help='drop the example sentences (smaller file)')
    ap.add_argument('--max-words', type=int, default=0, help='stop after this many words (for testing)')
    ap.add_argument('--multiword', action='store_true', help='also include multi-word entries such as "take off"')
    args = ap.parse_args()

    src = read_sources(args.source)
    entries = {}          # lemma -> list of [pos, definition, example]
    exc = {}

    for name, letter in POS_FILES:
        data = parse_data(src['data.' + name])
        exc.update(parse_exc(src[name + '.exc']))
        for lemma, offsets in parse_index(src['index.' + name]):
            word = lemma.replace('_', ' ')
            if not args.multiword and ' ' in word:
                continue
            kept = 0
            for off in offsets:
                if kept >= args.senses:
                    break
                got = data.get(off)
                if not got:
                    continue
                definition, example = got
                sense = [letter, definition] if args.no_examples or not example else [letter, definition, example]
                entries.setdefault(word, []).append(sense)
                kept += 1

    words = sorted(entries)
    if args.max_words:
        words = words[:args.max_words]

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    header = {'v': 1, 'name': 'WordNet 3.0', 'license': 'Princeton University WordNet licence',
              'built': datetime.date.today().isoformat(), 'words': len(words)}
    raw = 0
    with gzip.open(args.out, 'wt', encoding='utf-8', compresslevel=9) as fh:
        line = json.dumps(header, ensure_ascii=False) + '\n'
        fh.write(line); raw += len(line)
        for w in words:
            line = json.dumps([w, entries[w]], ensure_ascii=False) + '\n'
            fh.write(line); raw += len(line)
        line = json.dumps({'exc': exc}, ensure_ascii=False) + '\n'
        fh.write(line); raw += len(line)

    size = os.path.getsize(args.out)
    print('%s  %d words, %d irregular forms' % (args.out, len(words), len(exc)))
    print('  %.1f MB uncompressed, %.1f MB downloaded' % (raw / 1048576, size / 1048576))


if __name__ == '__main__':
    main()
