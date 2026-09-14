import {
  DEFAULT_LOCALE,
  getLocaleContext,
  translate,
  type Locale,
  type MessageKey,
  type MessageValues
} from './index';

/** Connect a component to the request-local locale context without shared server state. */
export function useLocale() {
  const context = getLocaleContext();
  let locale = $state<Locale>(context?.getLocale() ?? DEFAULT_LOCALE);

  $effect(() => {
    const unsubscribe = context?.subscribe((next) => (locale = next));
    return () => unsubscribe?.();
  });

  return {
    get locale() { return locale; },
    t(key: MessageKey, values?: MessageValues) { return translate(locale, key, values); }
  };
}
