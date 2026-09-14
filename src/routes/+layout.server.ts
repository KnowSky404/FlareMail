import type { LayoutServerLoad } from './$types';
import { resolveLocale } from '$lib/client/locale-preferences';

export const load: LayoutServerLoad = ({ cookies, request, locals }) => ({
  locale: locals.locale ?? resolveLocale({
    cookie: cookies.get('flaremail-locale') ?? null,
    acceptLanguage: request.headers.get('accept-language')
  })
});
