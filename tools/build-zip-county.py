"""Builds Florida ZIP -> county list from the U.S. Census 2020 ZCTA-County relationship file.
Output: zip-county-fl.json  {"33707": [["Pinellas", 1.0]], "33511": [["Hillsborough", 1.0]], ...}
Shares are by land area. Run by .github/workflows/build-zip-data.yml (GitHub has open internet)."""
import json, urllib.request, collections
URL = 'https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt'
raw = urllib.request.urlopen(urllib.request.Request(URL, headers={'User-Agent': 'Mozilla/5.0'}), timeout=120).read().decode('utf-8-sig')
lines = raw.splitlines(); head = lines[0].split('|'); ix = {k: i for i, k in enumerate(head)}
by = collections.defaultdict(list)
for l in lines[1:]:
    f = l.split('|')
    z, cfips, cname, land = f[ix['GEOID_ZCTA5_20']], f[ix['GEOID_COUNTY_20']], f[ix['NAMELSAD_COUNTY_20']], f[ix['AREALAND_PART']]
    if not z or not cfips.startswith('12'): continue
    by[z].append([cname.replace(' County', ''), int(land or 0)])
out = {}
for z in sorted(by):
    arr = sorted(by[z], key=lambda x: -x[1]); tot = sum(x[1] for x in arr) or 1
    out[z] = [[c, round(a / tot, 3)] for c, a in arr]
json.dump(out, open('zip-county-fl.json', 'w'), indent=0, sort_keys=True)
print('ZIPs:', len(out), 'multi-county:', sum(1 for v in out.values() if len(v) > 1), 'source lines:', len(lines))
