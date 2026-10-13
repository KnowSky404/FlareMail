export type MailDomain = {
  id: string;
  domain_name: string;
  enabled: number;
  cloudflare_zone_id: string;
  worker_name: string;
  unknown_recipient_policy: 'reject' | 'collect';
  catch_all_target: 'unknown' | 'this_worker' | 'external' | 'drop' | 'none';
  resend_status: 'unknown' | 'pending' | 'verified' | 'failed';
  resend_sending_status: 'unknown' | 'enabled' | 'disabled';
  resend_checked_at: string | null;
  cloudflare_checked_at: string | null;
  cloudflare_check_expires_at: string | null;
  cloudflare_next_check_at: string | null;
  cloudflare_error_code: string | null;
  resend_check_expires_at: string | null;
  resend_next_check_at: string | null;
  resend_error_code: string | null;
  cloudflare_configured: boolean;
  resend_configured: boolean;
};

export type MailAddress = {
  id: string;
  domain_id: string;
  email: string;
  display_name: string;
  signature: string;
  receive_enabled: number;
  send_enabled: number;
  is_default_sender: number;
  lifecycle_status: 'active' | 'disabled' | 'deleted';
  routing_state: 'pending' | 'provisioning' | 'active' | 'deleting' | 'imported' | 'unknown' | 'error' | 'deleted';
  routing_owner: 'flaremail' | 'imported' | null;
  delete_route_policy: 'remove_owned_route' | 'retain_reject_route' | 'preserve_imported_route' | null;
  last_error_code: string | null;
};

export type RouteStatus = 'managed' | 'imported' | 'importable' | 'missing' | 'conflict' | 'duplicate' | 'deleted_route' | 'deleted_absent' | 'imported_preserved' | 'reject_route_preserved';
export type DeletePolicy = 'remove_owned_route' | 'retain_reject_route' | 'preserve_imported_route';
export type DeletePreview = {
  previewedAt: string;
  expiresAt: string;
  historyRetained: true;
  cloudflare: {
    state: 'verified' | 'unavailable';
    errorCode: string | null;
    route: { observation: 'managed_worker' | 'imported_worker' | 'absent' | 'external_rule' | 'conflict' | 'unknown'; source: 'api' | 'wrangler' | null; ruleId: string | null };
    catchAll: { target: MailDomain['catch_all_target']; checkedAt: string | null; fresh: boolean; live: boolean };
  };
  policies: Record<DeletePolicy, { available: boolean; action: string | null }>;
  recommendedPolicy: DeletePolicy | null;
  canConfirm: boolean;
};
export type DomainCheck = {
  cloudflare: {
    state: 'ready' | 'error';
    errorCode: string | null;
    catchAllEnabled: boolean | null;
    catchAllTarget: MailDomain['catch_all_target'];
    checkedAt: string | null;
    addresses: Array<{ addressId: string; status: RouteStatus }>;
  };
  resend: { state: 'verified' | 'pending' | 'failed' | 'missing' | 'not_configured' | 'error'; errorCode?: string | null };
};
