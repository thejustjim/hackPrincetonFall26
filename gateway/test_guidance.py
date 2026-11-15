"""Checks for guidance.py, the search over published guidance. Run: python test_guidance.py
The checks that need the document index are skipped, and say so, on a machine where
fetch_guidance.py has not been run."""
import guidance as G

ok = True


def check(name, cond, detail=""):
    global ok
    ok &= bool(cond)
    print(("PASS" if cond else "FAIL"), name, detail if not cond else "")


st = G.status()
found = G.search("when should the ZeroWater filter be replaced")
check("the makers' rules are always searchable", found and "ZeroWater" in found[0]["document"] and "006" in found[0]["text"], found[:1])
check("an unrelated query finds nothing", G.search("xyzzy qwrtp") == [])
check("an empty query finds nothing", G.search("") == [] and G.search(None) == [])
check("every result names its document and who prepared it", all(r["document"] and r["prepared_by"] for r in G.search("replace filter cartridge", 3)))
check("plurals and -ing forms match", G.tokens("flushing mains") == G.tokens("flush main"))

if not st["documents"]:
    print("SKIP the document checks: no guidance_index.json here (run python fetch_guidance.py)")
else:
    check("the index holds EPA and AWWA-prepared documents", st["documents"] >= 10 and st["passages"] > 500, st)
    r = G.search("flush the main after a repair before returning it to service", 3)
    check("a repair question reaches the AWWA-prepared paper on water mains", any("New or Repaired Water Mains" in x["document"] and "AWWA" in x["prepared_by"] for x in r), [x["document"] for x in r])
    r = G.search("unidirectional flushing velocity", 3)
    check("a flushing question reaches EPA's flushing fact sheet", any("Flushing" in x["document"] for x in r), [x["document"] for x in r])
    r = G.search("confirm possible contamination with laboratory analysis of samples", 3)
    check("a lab-confirmation question reaches EPA's response guidance", any("Contamination" in x["document"] or "Monitoring" in x["document"] for x in r), [x["document"] for x in r])
    r = G.search("total dissolved solids secondary standard", 3)
    check("the dissolved-solids guideline comes from EPA's page, not a team note", r and r[0]["document"].startswith("Secondary Drinking Water Standards"), [x["document"] for x in r])
    r = G.search("sensor calibration and maintenance of monitoring stations", 4)
    check("document passages carry a page and a URL", all(x["url"] and x["url"].startswith("https://www.epa.gov/") for x in r) and any(x["page"] for x in r), r[:1])
    check("no more than two passages come from one document", max(sum(y["document"] == x["document"] for y in r) for x in r) <= 2)
    check("passages are short enough to quote", all(len(x["text"]) <= 1400 for x in r), [len(x["text"]) for x in r])

print("\nall passed" if ok else "\nFAILURES")
raise SystemExit(0 if ok else 1)
