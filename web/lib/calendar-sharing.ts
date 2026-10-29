export interface RegistrationPolicy {
  version: number;
  occurrence_key: string;
  approval_mode: string;
  capacity: number | null;
  waitlist_enabled: boolean;
  additional_guests_limit: number;
  registration_opens_at: number | null;
  registration_closes_at: number | null;
  allowed_email_domains: string[];
  form_schema: unknown[];
  status: string;
}
export function registrationPolicyBody(
  policy: RegistrationPolicy,
  occurrenceKey: string,
  changes: Partial<RegistrationPolicy>,
) {
  return {
    version: policy.occurrence_key === occurrenceKey ? policy.version : 0,
    ...(occurrenceKey ? { occurrence_key: occurrenceKey } : {}),
    capacity: changes.capacity === undefined ? policy.capacity : changes.capacity,
    approval_mode: changes.approval_mode ?? policy.approval_mode,
    waitlist_enabled: changes.waitlist_enabled ?? policy.waitlist_enabled,
    additional_guests_limit: changes.additional_guests_limit ?? policy.additional_guests_limit,
    status: changes.status ?? policy.status,
    registration_opens_at: policy.registration_opens_at,
    registration_closes_at: policy.registration_closes_at,
    allowed_email_domains: policy.allowed_email_domains,
    form_schema: policy.form_schema,
  };
}
