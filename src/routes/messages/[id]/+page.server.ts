import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import { translate } from '$lib/i18n';
import { buildWorkspaceBackHref, readWorkspaceMessage } from '$lib/server/workspace/reader';

const pageError = (status: number, message: string, requestId: string): never =>
  error(status, { message, requestId });

export const load: PageServerLoad = async ({ locals, params, platform, url }) => {
  const requestId = locals.requestId ?? crypto.randomUUID();
  const locale = locals.locale ?? 'zh-CN';
  if (locals.runtimeState) throw pageError(503, translate(locale, 'reader.runtimeUnavailable'), requestId);
  const session = locals.workspaceSession;
  if (!session) throw pageError(401, translate(locale, 'reader.loginRequired'), requestId);

  const env = platform?.env as CloudflareEnv | undefined;
  if (!env?.DB || session.storage !== 'd1') throw pageError(503, translate(locale, 'reader.storageUnavailable'), requestId);

  const message = await readWorkspaceMessage(env, session, params.id);
  if (!message) throw pageError(404, translate(locale, 'reader.messageNotFound'), requestId);

  return {
    message,
    profile: session.profile,
    backHref: buildWorkspaceBackHref(url, message)
  };
};
