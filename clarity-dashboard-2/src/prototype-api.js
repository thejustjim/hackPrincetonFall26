// Read-only connection gates. Prototype mode must never label a mock gateway Live.
export async function prototypeHealth(getJSON) {
  const health = await getJSON('/health');
  if (!health || health.mock !== false || health.ok === false) {
    throw new Error('A physical prototype gateway is required; this gateway is simulated or unverified.');
  }
  return health;
}
export async function prototypeNodes(getJSON) {
  await prototypeHealth(getJSON);
  const nodes = await getJSON('/api/nodes');
  if (!Array.isArray(nodes)) throw new Error('The prototype gateway returned an invalid node list.');
  return nodes;
}
export function demoReturnURL(pageURL, mode, api = '') {
  const url = new URL('../demo/', pageURL);
  url.searchParams.set('mode', mode === 'demo' ? 'demo' : 'prototype');
  if (mode === 'demo') url.searchParams.set('demo', '1');
  else if (api) url.searchParams.set('api', api);
  return url.href;
}
