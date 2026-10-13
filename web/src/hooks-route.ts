export type Route = { kind: 'home' } | { kind: 'job'; id: string } | { kind: 'run'; id: string };

/** Reads the route from the address: #/jobs/<id>, #/runs/<id>, anything else is the home page. */
export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/');
  const id = parts[1];
  if (parts[0] === 'jobs' && id) return { kind: 'job', id: decodeURIComponent(id) };
  if (parts[0] === 'runs' && id) return { kind: 'run', id: decodeURIComponent(id) };
  return { kind: 'home' };
}
