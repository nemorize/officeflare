import type { CalendarEnv } from "./types";
import { rows } from "./access";
export interface RecipientUser {
  id: string;
  email_address: string;
  display_name: string | null;
}
// Personal mailbox aliases have an authoritative owner. Shared mailbox addresses
// do not identify one attendee and must never grant a random member an invitation.
export async function recipientUser(env: CalendarEnv, address: string) {
  const matches = await rows<RecipientUser>(
    env,
    "SELECT u.id,u.email_address,u.display_name FROM users u WHERE lower(u.email_address)=? UNION SELECT u.id,u.email_address,u.display_name FROM mail_addresses a JOIN mail_domains d ON d.id=a.domain_id JOIN mail_mailboxes b ON b.id=a.mailbox_id AND b.kind='personal' JOIN users u ON u.id=b.owner_user_id WHERE lower(a.local_part||'@'||d.name)=?",
    address.toLowerCase(),
    address.toLowerCase(),
  );
  return {
    user: matches.length === 1 ? matches[0]! : null,
    ambiguous: matches.length > 1,
  };
}
export const noInternalRecipientSql = (emailExpression: string) =>
  `NOT EXISTS(SELECT 1 FROM users u WHERE lower(u.email_address)=${emailExpression}) AND NOT EXISTS(SELECT 1 FROM mail_addresses ma JOIN mail_domains md ON md.id=ma.domain_id JOIN mail_mailboxes mb ON mb.id=ma.mailbox_id WHERE mb.kind='personal' AND lower(ma.local_part||'@'||md.name)=${emailExpression})`;
