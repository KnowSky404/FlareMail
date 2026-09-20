import { json } from '@sveltejs/kit';
import { getRequestId } from '$lib/server/http/api';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  return json(
    { ok: true },
    { headers: { 'cache-control': 'no-store', 'x-request-id': requestId } }
  );
};
