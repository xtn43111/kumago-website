#!/usr/bin/env python3
"""KUMAGO — match old blurry event photos to new hi-res note captures.

The 2025-06→10 backfill uploaded 192px PDF thumbnails; the hi-res originals
re-captured from the iCloud notes (tools/note_capture.js v2) are the SAME
pictures, so a perceptual hash (dHash) pairs them automatically.

Usage:
  python3 tools/match_note_photos.py <audit.json> <capture_dir> <prefix> \
      --from 2025-06-01 --to 2025-07-01 [--out mapping.json]

* audit.json: .tmp/photo_audit.json rows (eventId, date, summary, ids[])
* capture_dir/prefix: where note_capture.js saved <prefix>_###.jpg
* Downloads each old photo via the bot token (cached in .tmp/old_photos/).
* Writes mapping.json rows for tools/attach_note_photos.js and a report of
  match distances; anything with distance > 12 is flagged for eyeball review.
"""
import argparse, glob, hashlib, json, os, subprocess, sys, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from PIL import Image

def load_env():
    envp = os.path.join(ROOT, ".env")
    if not os.path.exists(envp):
        return
    for line in open(envp):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())

def dhash(img, size=8):
    g = img.convert("L").resize((size + 1, size), Image.LANCZOS)
    px = list(g.getdata())
    bits = 0
    for r in range(size):
        for c in range(size):
            bits = (bits << 1) | (1 if px[r * (size + 1) + c] > px[r * (size + 1) + c + 1] else 0)
    return bits

def ham(a, b):
    return bin(a ^ b).count("1")

def fetch_old(fid, cache_dir, token):
    out = os.path.join(cache_dir, hashlib.md5(fid.encode()).hexdigest() + ".jpg")
    if os.path.exists(out):
        return out
    with urllib.request.urlopen(f"https://api.telegram.org/bot{token}/getFile?file_id={urllib.parse.quote(fid)}") as r:
        j = json.load(r)
    if not j.get("ok"):
        raise RuntimeError(f"getFile failed for {fid[:20]}…: {j}")
    with urllib.request.urlopen(f"https://api.telegram.org/file/bot{token}/{j['result']['file_path']}") as r:
        data = r.read()
    open(out, "wb").write(data)
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audit"); ap.add_argument("capture_dir"); ap.add_argument("prefix")
    ap.add_argument("--from", dest="dfrom", required=True)
    ap.add_argument("--to", dest="dto", required=True)
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    load_env()
    token = os.environ["TELEGRAM_BOT_TOKEN"]
    cache = os.path.join(ROOT, ".tmp", "old_photos"); os.makedirs(cache, exist_ok=True)

    rows = [r for r in json.load(open(a.audit))
            if r.get("blurry") and a.dfrom <= r["date"] < a.dto]
    caps = sorted(glob.glob(os.path.join(a.capture_dir, a.prefix + "_[0-9][0-9][0-9].*")))
    caps = [c for c in caps if not c.endswith(".json")]
    if not caps:
        sys.exit("no captures found")
    print(f"{len(rows)} blurry events in window · {len(caps)} captured photos")

    cap_h = {}
    for c in caps:
        try:
            cap_h[c] = dhash(Image.open(c))
        except Exception as e:
            print(f"  !! cannot read {os.path.basename(c)}: {e}")

    TH = 10  # dHash distance: <=TH → trust the hi-res match; else keep original
    mapping, report, used = [], [], {}
    tot_up = tot_keep = 0
    for r in rows:
        slots, dists = [], []
        for fid in r["ids"]:
            old = fetch_old(fid, cache, token)
            oh = dhash(Image.open(old))
            best, bd = None, 999
            for c, ch in cap_h.items():
                d = ham(oh, ch)
                if d < bd:
                    best, bd = c, d
            dists.append(bd)
            if bd <= TH:
                slots.append(os.path.relpath(best, ROOT))  # upgrade to hi-res
                used.setdefault(best, []).append((r["summary"][:20], bd))
                tot_up += 1
            else:
                slots.append({"keepId": fid})               # no reliable match → keep original
                tot_keep += 1
        mapping.append({"eventId": r["eventId"], "label": r["summary"][:40], "images": slots})
        nkeep = sum(1 for s in slots if isinstance(s, dict))
        flag = f"  (保留 {nkeep})" if nkeep else ""
        report.append(f"{r['date']} {r['summary'][:34]:34s} dists={dists}{flag}")
        print(report[-1])
    print(f"\n升級 {tot_up} 張 / 保留原圖 {tot_keep} 張")

    dupes = {os.path.basename(k): v for k, v in used.items() if len(v) > 1}
    if dupes:
        print("\n⚠️ capture files matched by MULTIPLE old photos (check):")
        for k, v in dupes.items():
            print(f"  {k}: {v}")

    outp = a.out or os.path.join(ROOT, ".tmp", f"mapping_{a.prefix}.json")
    json.dump(mapping, open(outp, "w"), ensure_ascii=False, indent=2)
    print(f"\nwrote {outp} ({len(mapping)} events)")

if __name__ == "__main__":
    main()
