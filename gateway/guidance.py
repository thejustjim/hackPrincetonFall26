"""Search the guidance the maintenance agent may cite.

Two sources, searched together:
  - guidance_index.json: passages from published EPA documents and from the distribution-system
    issue papers AWWA prepared for EPA (built by fetch_guidance.py; see its DOCUMENTS list)
  - guidance.json: the team's own short notes, mostly the filter makers' replacement rules,
    which no EPA or AWWA document covers

The ranking is BM25, the standard keyword ranking: a passage scores higher the more of the
query's rarer words it contains, with long passages marked down. There are no embeddings and
no model call, so it works offline and the same query always gives the same passages. Every
result says which document and page it came from, so the agent can cite it.
"""
import json
import math
import re
from pathlib import Path

INDEX_PATH = Path(__file__).with_name("guidance_index.json")
NOTES_PATH = Path(__file__).with_name("guidance.json")
STOP = set("a an and are as at be been but by can for from has have if in into is it its may more must not of on or such "
           "than that the their then there these this those to was were when which who will with would should also each "
           "any all other some how what where do does".split())
K1, B = 1.5, 0.75
_cache = {"key": None, "index": None}


def tokens(text):
    out = []
    for w in re.findall(r"[a-z0-9]+", text.lower()):
        if w in STOP or len(w) < 2:
            continue
        for end, to in (("ies", "y"), ("ing", ""), ("ed", ""), ("es", ""), ("s", "")):       # a light stemmer
            if len(w) > len(end) + 3 and w.endswith(end):
                w = w[: -len(end)] + to
                break
        out.append(w)
    return out


def _load():
    key = tuple(p.stat().st_mtime if p.exists() else 0 for p in (INDEX_PATH, NOTES_PATH))
    if _cache["key"] == key:
        return _cache["index"]
    rows, documents, built = [], [], None
    try:
        data = json.loads(INDEX_PATH.read_text())
        documents, built = data["documents"], data.get("built_at")
        for doc, page, text in data["passages"]:
            d = documents[doc]
            rows.append({"text": text, "document": d["title"], "prepared_by": d["prepared_by"], "year": d["year"],
                         "number": d["number"], "page": page, "url": d["url"], "kind": "document", "key": d["id"]})
    except Exception:
        pass                                           # no index on this machine: the notes alone
    notes = 0
    try:
        for n in json.loads(NOTES_PATH.read_text())["notes"]:
            if documents and n.get("fallback"):        # the published documents cover these
                continue
            rows.append({"text": n["text"], "document": f"Clarity team note: {n['topic']}", "prepared_by": n["source"], "year": None,
                         "number": "team note", "page": None, "url": None, "kind": "note", "key": n["id"], "topic": n["topic"]})
            notes += 1
    except Exception:
        pass
    postings, lengths = {}, []
    for i, r in enumerate(rows):
        terms = tokens(r["text"] + " " + r.get("topic", ""))
        lengths.append(len(terms))
        for t in set(terms):
            postings.setdefault(t, []).append((i, terms.count(t)))
    index = {"rows": rows, "postings": postings, "lengths": lengths, "mean": sum(lengths) / max(1, len(lengths)),
             "status": {"documents": len(documents), "passages": len(rows) - notes, "notes": notes, "built_at": built,
                        "titles": [d["title"] for d in documents]}}
    _cache.update(key=key, index=index)
    return index


def status():
    """What there is to search: how many documents, passages and team notes."""
    return _load()["status"]


def search(query, k=3):
    """Up to k passages, best first, at most two from any one document."""
    ix = _load()
    n, scores = len(ix["rows"]), {}
    for t in set(tokens(query or "")):
        hits = ix["postings"].get(t)
        if not hits:
            continue
        idf = math.log(1 + (n - len(hits) + 0.5) / (len(hits) + 0.5))
        for i, tf in hits:
            scores[i] = scores.get(i, 0.0) + idf * tf * (K1 + 1) / (tf + K1 * (1 - B + B * ix["lengths"][i] / ix["mean"]))
    out, per = [], {}
    for i, score in sorted(scores.items(), key=lambda x: -x[1]):
        r = ix["rows"][i]
        if per.get(r["key"], 0) >= (2 if r["kind"] == "document" else 1):
            continue
        per[r["key"]] = per.get(r["key"], 0) + 1
        out.append({k2: r[k2] for k2 in ("text", "document", "prepared_by", "year", "number", "page", "url")} | {"score": round(score, 2)})
        if len(out) >= k:
            break
    return out
