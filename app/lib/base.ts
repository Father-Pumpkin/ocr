/**
 * The path the app is mounted under — '' at a domain root, or e.g.
 * '/projects/feeling-narrative' when served behind another site.
 *
 * Read from the <base href> the server writes into index.html (derived from
 * BASE_URL), so one build runs at any mount point. Every absolute URL the app
 * makes — router links, API calls, image and download hrefs — goes through this.
 */
export const BASE_PATH = new URL(document.baseURI).pathname.replace(/\/+$/, '');

/** Prefix an absolute app path ('/api/…') with the mount point. */
export function withBase(path: string): string {
  return `${BASE_PATH}${path}`;
}
