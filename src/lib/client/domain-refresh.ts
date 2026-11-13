/** Two domains at a time; a failed domain must not suppress the remaining checks. */
export async function refreshDomains<T>(
  ids: string[], refresh: (id: string) => Promise<T>,
  onResult: (id: string, result: PromiseSettledResult<T>) => void,
  active: () => boolean
) {
  let next = 0;
  async function run() {
    while (next < ids.length && active()) {
      const id = ids[next++]!;
      let result: PromiseSettledResult<T>;
      try { result = { status: 'fulfilled', value: await refresh(id) }; }
      catch (reason) { result = { status: 'rejected', reason }; }
      if (active()) onResult(id, result);
    }
  }
  await Promise.all([run(), run()]);
}

export function domainCheckNeedsAttention(check: {
  cloudflare: { state: string; errorCode?: string | null; addresses?: Array<{ status: string }> };
  resend: { state: string; errorCode?: string | null };
}) {
  return check.cloudflare.state !== 'ready' || Boolean(check.cloudflare.errorCode) ||
    Boolean(check.cloudflare.addresses?.some((address) =>
      !['managed', 'imported', 'deleted_absent', 'imported_preserved', 'reject_route_preserved'].includes(address.status))) ||
    !['verified', 'not_configured'].includes(check.resend.state) || Boolean(check.resend.errorCode);
}
