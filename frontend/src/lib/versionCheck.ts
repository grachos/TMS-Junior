/**
 * Light TMS - "Hay una versión nueva" detection.
 *
 * The app is a single-page app: a tab that was opened before a release keeps
 * running the old code until it is reloaded (nothing refetches index.html while
 * you navigate inside it). Each build gets an id (baked into the code as
 * __BUILD_ID__ and written to /version.json); a tab compares its own id with
 * the server's and, if they differ, offers a reload. It never reloads by itself:
 * the user may be in the middle of a form.
 *
 * Pure and dependency-free so it can be unit-tested.
 */

/**
 * True only when the server clearly reports a DIFFERENT build than the one
 * running. Any doubt (dev build, network error, unexpected response) is "no":
 * a false alarm would be worse than a late notice.
 */
export async function hayVersionNueva(idActual: string, leerServidor: () => Promise<unknown>): Promise<boolean> {
  if (!idActual || idActual === 'dev') return false;
  try {
    const id = ((await leerServidor()) as { id?: unknown } | null)?.id;
    return typeof id === 'string' && id !== '' && id !== idActual;
  } catch {
    return false;
  }
}

/** Reads /version.json (never from a cache). Throws if the response isn't the JSON file. */
export async function leerVersionDelServidor(): Promise<unknown> {
  const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) throw new Error('sin version.json');
  return res.json();
}
