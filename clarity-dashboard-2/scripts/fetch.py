import os, sys, time, json
import pyarrow.dataset as ds, pyarrow.fs as pafs, pyarrow.compute as pc, pyarrow.parquet as pq
os.environ.setdefault('AWS_CA_BUNDLE', '/root/.ccr/ca-bundle.crt')
proxy = os.environ.get('HTTPS_PROXY') or os.environ.get('https_proxy')
fs = pafs.S3FileSystem(anonymous=True, region='us-west-2', proxy_options=proxy, connect_timeout=20, request_timeout=60)
REL = 'overturemaps-us-west-2/release/2026-10-21.0'
W, S, E, N = map(float, sys.argv[2].split(','))
theme = sys.argv[1]  # e.g. buildings/building
t, ty = theme.split('/')
cols = sys.argv[3].split(',')
d = ds.dataset(f'{REL}/theme={t}/type={ty}/', filesystem=fs, format='parquet')
f = (pc.field('bbox', 'xmin') < E) & (pc.field('bbox', 'xmax') > W) & (pc.field('bbox', 'ymin') < N) & (pc.field('bbox', 'ymax') > S)
t0 = time.time()
tbl = d.to_table(columns=cols, filter=f)
print(theme, tbl.num_rows, f'{time.time()-t0:.0f}s', file=sys.stderr)
pq.write_table(tbl, f'{t}_{ty}.parquet')
