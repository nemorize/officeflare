import type { AuthEnv } from "../auth/types";
import { activeAccountSql, mailAccessSql, sender as mailSender } from "../mail/control";
import { providers } from "../mail/providers";
import { condition, first } from "./access";

interface PersonalSenderIdentity {
  user_id: string;
  auth_version: number;
  mailbox_id: string;
  address_id: string;
}
export type PersonalInvitationSender = PersonalSenderIdentity &
  Awaited<ReturnType<typeof mailSender>>;

// Mailbox ownership and Mail's existing send authorization both apply. Shared
// mailboxes and addresses belonging to another user are never implicit senders.
export async function personalInvitationSender(
  env: AuthEnv,
  userId: string | null,
): Promise<PersonalInvitationSender | null> {
  if (!userId) return null;
  const identity = await first<PersonalSenderIdentity>(
    env,
    `SELECT u.id user_id,u.auth_version,b.id mailbox_id,a.id address_id
     FROM users u JOIN mail_mailboxes b ON b.owner_user_id=u.id
     JOIN mail_addresses a ON a.mailbox_id=b.id
     JOIN mail_domains d ON d.id=a.domain_id
     JOIN mail_provider_connections p ON p.id=d.outbound_connection_id
     WHERE u.id=? AND ${activeAccountSql} AND ${mailAccessSql}
       AND b.kind='personal' AND b.status='active' AND a.send_enabled=1
       AND d.outbound_enabled=1 AND p.enabled=1
       AND p.provider IN(SELECT value FROM json_each(?))
     ORDER BY a.is_primary DESC,b.created_at,b.id,a.created_at,a.id LIMIT 1`,
    userId,
    JSON.stringify(
      providers
        .filter((value) => value.capabilities.send && (value.id !== "cloudflare" || !!env.EMAIL))
        .map((value) => value.id),
    ),
  );
  if (!identity) return null;
  try {
    const selected = await mailSender(
      env,
      {
        user_id: identity.user_id,
        auth_version: identity.auth_version,
        api_key_id: null,
      },
      identity.mailbox_id,
      identity.address_id,
    );
    return { ...identity, ...selected };
  } catch (error) {
    // A concurrent revocation or unsupported provider must not fall back to a
    // different person's address. Database/runtime failures still retry.
    if (error instanceof Error && /^MAIL:(403|409|422):/.test(error.message)) return null;
    throw error;
  }
}

// Bind the final Queue claim to the same account, address and provider used by
// the immutable submission snapshot; recheck immediately before provider send.
export function personalSenderCondition(sender: PersonalInvitationSender) {
  return condition(
    `EXISTS(SELECT 1 FROM users u JOIN mail_mailboxes b ON b.owner_user_id=u.id
     JOIN mail_addresses a ON a.mailbox_id=b.id JOIN mail_domains d ON d.id=a.domain_id
     JOIN mail_provider_connections p ON p.id=d.outbound_connection_id
     WHERE u.id=? AND u.auth_version=? AND ${activeAccountSql} AND ${mailAccessSql}
       AND b.id=? AND b.kind='personal' AND b.status='active'
       AND a.id=? AND a.send_enabled=1 AND a.local_part||'@'||d.name=?
       AND d.outbound_enabled=1 AND p.id=? AND p.provider=? AND p.version=? AND p.enabled=1
       AND d.max_send_bytes IS ?)`,
    sender.user_id,
    sender.auth_version,
    sender.mailbox_id,
    sender.address_id,
    sender.email_address,
    sender.connection_id,
    sender.provider,
    sender.version,
    sender.max_send_bytes,
  );
}
