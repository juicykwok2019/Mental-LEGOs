import path from 'node:path';

export const RENDERER_SCHEME = 'mental-legos';
export const RENDERER_HOST = 'app';
export const PACKAGED_RENDERER_URL = `${RENDERER_SCHEME}://${RENDERER_HOST}/index.html`;
export const PACKAGED_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "worker-src 'none'",
].join('; ');

export function resolveRendererAssetPath(
  requestUrl: string,
  rendererRoot: string,
): string | null {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(requestUrl);
  } catch {
    return null;
  }

  if (
    parsedUrl.protocol !== `${RENDERER_SCHEME}:`
    || parsedUrl.hostname !== RENDERER_HOST
  ) {
    return null;
  }

  let relativePath: string;
  try {
    relativePath = decodeURIComponent(parsedUrl.pathname).replace(/^\/+/, '');
  } catch {
    return null;
  }

  if (!relativePath || relativePath.includes('\0')) {
    return null;
  }

  const resolvedRoot = path.resolve(rendererRoot);
  const resolvedAsset = path.resolve(resolvedRoot, relativePath);
  const rootPrefix = `${resolvedRoot}${path.sep}`;

  if (!resolvedAsset.startsWith(rootPrefix)) {
    return null;
  }

  return resolvedAsset;
}
