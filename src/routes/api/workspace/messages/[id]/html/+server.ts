import type { RequestHandler } from './$types';
import { classifyRuntimeError, getRequestId } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceSession } from '$lib/server/workspace-api';
import { renderOwnedSafeHtml } from '$lib/server/workspace/html';

function responseHeaders(requestId: string, allowRemoteImages: boolean) {
  const imageSources = allowRemoteImages ? "'self' https:" : "'self'";
  return {
    'cache-control': 'private, no-store',
    'content-security-policy': `default-src 'none'; base-uri 'none'; connect-src 'none'; font-src 'none'; form-action 'none'; frame-ancestors 'self'; frame-src 'none'; img-src ${imageSources}; media-src 'none'; object-src 'none'; script-src 'none'; style-src 'unsafe-inline'; sandbox allow-popups allow-popups-to-escape-sandbox`,
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'SAMEORIGIN',
    'x-request-id': requestId
  };
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const allowRemoteImages = event.url.searchParams.get('remote') === '1';
  try {
    const session = requireWorkspaceSession(event);
    const rendered = await renderOwnedSafeHtml(getRequestEnv(event), session, event.params.id, { allowRemoteImages });
    return new Response(rendered.document, {
      headers: {
        ...responseHeaders(requestId, allowRemoteImages),
        'content-type': 'text/html; charset=utf-8'
      }
    });
  } catch (error) {
    const classified = classifyRuntimeError(error);
    return new Response(classified.message, {
      status: classified.status,
      headers: {
        ...responseHeaders(requestId, false),
        'content-type': 'text/plain; charset=utf-8'
      }
    });
  }
};
