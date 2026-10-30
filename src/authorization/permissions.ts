import { t } from "../../shared/i18n/index.ts";
export const permissionGroups = {
  services: t("permissions.serviceAccess"),
  users: t("permissions.userAdministration"),
  security: t("permissions.accountSecurity"),
  roles: t("permissions.roleAdministration"),
  assignments: t("permissions.roleAssignments"),
  mail: t("permissions.mailAdministration"),
  drive: t("permissions.driveUsage"),
  driveAdmin: t("permissions.driveAdministration"),
  calendar: t("permissions.calendarUsage"),
} as const;
export interface PermissionDefinition {
  label: string;
  description: string;
  group: keyof typeof permissionGroups;
  requires: readonly string[];
  impact?: string;
}
const userRead = ["admin.users.read"] as const;
const roleRead = ["admin.roles.read"] as const;
const assignmentRead = ["admin.users.roles.read"] as const;
// One catalog drives API policies, role validation and the management UI.
// Service access never grants access to another user's mailbox or files.
export const permissionCatalog = {
  "console.access": {
    label: t("permissions.accessConsole"),
    description: t("permissions.openSystemSettingsManagementActionsRequireTheirOwnPermissions"),
    group: "services",
    requires: [],
  },
  "mail.access": {
    label: t("permissions.accessMail"),
    description: t("permissions.useMailWithOwnedOrExplicitlySharedMailboxesDoes"),
    group: "services",
    requires: [],
  },
  "calendar.access": {
    label: t("permissions.accessCalendar"),
    description: t("permissions.openTheCalendarWorkspace"),
    group: "services",
    requires: [],
  },
  "calendar.calendars.create": {
    label: t("permissions.createCalendars"),
    description: t("permissions.createAdditionalCalendarsSharingRemainsSubjectToCalendarAccess"),
    group: "calendar",
    requires: ["calendar.access"],
  },
  "calendar.events.create": {
    label: t("permissions.createCalendarEvents"),
    description: t("permissions.createAndDuplicateEventsInCalendarsWhereYouHave"),
    group: "calendar",
    requires: ["calendar.access"],
  },
  "calendar.events.update": {
    label: t("permissions.editCalendarEvents"),
    description: t("permissions.editMoveAndRestoreEventsWhereCalendarWritingAccess"),
    group: "calendar",
    requires: ["calendar.access"],
  },
  "calendar.events.delete": {
    label: t("permissions.deleteCalendarEvents"),
    description: t("permissions.cancelEventsAndRecurringOccurrencesWhereCalendarWritingAccess"),
    group: "calendar",
    requires: ["calendar.access"],
  },
  "calendar.sharing.internal": {
    label: t("permissions.shareCalendarsInternally"),
    description: t("permissions.manageCalendarGrantsWhereYouHaveManagementAccess"),
    group: "calendar",
    requires: ["calendar.access"],
  },
  "calendar.sharing.external": {
    label: t("permissions.shareCalendarLinks"),
    description: t("permissions.createAndManageExternalViewingAndRegistrationLinks"),
    group: "calendar",
    requires: ["calendar.access"],
  },
  "calendar.events.invite": {
    label: t("permissions.inviteCalendarAttendees"),
    description: t("permissions.invitePeopleAndManageRegistrationsInWritableEvents"),
    group: "calendar",
    requires: ["calendar.access"],
  },
  "calendar.groups.manage": {
    label: t("permissions.manageCalendarGroups"),
    description: t("permissions.manageGroupsOwnedByYourAccount"),
    group: "calendar",
    requires: ["calendar.access"],
  },
  "admin.calendar.settings.read": {
    label: t("permissions.readCalendarSettings"),
    description: t("permissions.readWorkspaceSharingAndSystemSenderSettings"),
    group: "calendar",
    requires: ["console.access"],
  },
  "admin.calendar.settings.manage": {
    label: t("permissions.manageCalendarSettings"),
    description: t("permissions.changeWorkspaceSharingPolicyAndTheSystemInvitationSender"),
    group: "calendar",
    requires: ["admin.calendar.settings.read"],
  },
  "drive.access": {
    label: t("permissions.accessDrive"),
    description: t("permissions.useOwnedAndExplicitlySharedFilesAndFoldersDoes"),
    group: "services",
    requires: [],
  },
  "drive.files.create": {
    label: t("permissions.createDriveFilesAndFolders"),
    description: t("permissions.uploadFilesCreateFoldersAndCopyAccessibleItemsFolder"),
    group: "drive",
    requires: ["drive.access"],
  },
  "drive.files.update": {
    label: t("permissions.editDriveFiles"),
    description: t("permissions.replaceContentRenameMoveRestoreAndManageFileVersions"),
    group: "drive",
    requires: ["drive.access"],
  },
  "drive.files.delete": {
    label: t("permissions.deleteOwnedDriveItems"),
    description: t("permissions.trashOwnedItemsAndPermanentlyDeleteItemsAlreadyIn"),
    group: "drive",
    requires: ["drive.access"],
  },
  "drive.files.download": {
    label: t("permissions.downloadDriveFiles"),
    description: t("permissions.downloadAndCopyFilesYouOwnOrCanAccess"),
    group: "drive",
    requires: ["drive.access"],
  },
  "drive.comments.create": {
    label: t("permissions.commentInDrive"),
    description: t("permissions.addAndManageCommentsWhereTheItemSharingRole"),
    group: "drive",
    requires: ["drive.access"],
  },
  "drive.sharing.internal": {
    label: t("permissions.shareDriveItemsInternally"),
    description: t("permissions.shareOwnedItemsWithWorkspaceAccountsAndTransferOwnership"),
    group: "drive",
    requires: ["drive.access"],
  },
  "drive.sharing.public": {
    label: t("permissions.createPublicDriveLinks"),
    description: t("permissions.createAndUpdatePublicLinksForOwnedItemsSubject"),
    group: "drive",
    requires: ["drive.access"],
    impact: t("permissions.allowsExternalAccessToSharedFiles"),
  },
  "admin.drive.settings.read": {
    label: t("permissions.viewDriveSettings"),
    description: t("permissions.inspectWorkspaceStorageSharingAndRetentionPolicies"),
    group: "driveAdmin",
    requires: ["console.access"],
  },
  "admin.drive.settings.manage": {
    label: t("permissions.manageDriveSettings"),
    description: t("permissions.changeWorkspaceDrivePoliciesAndDefaultStorageLimits"),
    group: "driveAdmin",
    requires: ["admin.drive.settings.read"],
    impact: t("permissions.changesApplyToExistingLinksAndAccountsUsingDefaults"),
  },
  "admin.drive.accounts.read": {
    label: t("permissions.viewDriveAccounts"),
    description: t("permissions.inspectUserStorageUsageLimitsAndDriveAvailabilityIncluding"),
    group: "driveAdmin",
    requires: ["console.access"],
  },
  "admin.drive.accounts.manage": {
    label: t("permissions.manageDriveAccounts"),
    description: t("permissions.setStorageOverridesAndSuspendOrRestrictDriveWrites"),
    group: "driveAdmin",
    requires: ["admin.drive.accounts.read"],
  },
  "admin.drive.items.read": {
    label: t("permissions.viewDriveInventory"),
    description: t("permissions.inspectFileAndFolderMetadataAndTrashDoesNot"),
    group: "driveAdmin",
    requires: ["console.access"],
  },
  "admin.drive.sharing.read": {
    label: t("permissions.viewDriveSharing"),
    description: t("permissions.inspectInternalGrantsAndPublicLinkMetadataAcrossThe"),
    group: "driveAdmin",
    requires: ["console.access"],
  },
  "admin.drive.sharing.manage": {
    label: t("permissions.manageDriveSharing"),
    description: t("permissions.changeOrRevokeInternalGrantsAndRevokePublicLinks"),
    group: "driveAdmin",
    requires: ["admin.drive.sharing.read", "admin.drive.accounts.read"],
    impact: t("permissions.changesRecipientsAccess"),
  },
  "admin.drive.audit.read": {
    label: t("permissions.viewDriveAuditLogs"),
    description: t("permissions.searchFileActivityAndImmutableAdministratorRecordsAcrossThe"),
    group: "driveAdmin",
    requires: ["console.access"],
  },
  "admin.drive.ownership.transfer": {
    label: t("permissions.transferDriveOwnership"),
    description: t("permissions.handOverFilesOrAnAccountSInventoryIncluding"),
    group: "driveAdmin",
    requires: ["admin.drive.accounts.read", "admin.drive.items.read"],
    impact: t("permissions.grantsTheRecipientOwnershipAndRevokesPublicLinks"),
  },
  "admin.drive.trash.restore": {
    label: t("permissions.restoreDriveTrash"),
    description: t("permissions.restoreTrashedItemsWithoutOpeningFileContents"),
    group: "driveAdmin",
    requires: ["admin.drive.items.read"],
  },
  "admin.drive.trash.purge": {
    label: t("permissions.permanentlyDeleteDriveTrash"),
    description: t("permissions.permanentlyDeleteItemsAlreadyInTrashAndQueueTheir"),
    group: "driveAdmin",
    requires: ["admin.drive.items.read"],
    impact: t("permissions.permanentlyRemovesFilesAndTheirVersions"),
  },
  "admin.users.read": {
    label: t("permissions.viewAdministrativeUserRecords"),
    description: t("permissions.inspectAccountDetailsStatusAndSignInActivityIn"),
    group: "users",
    requires: ["console.access"],
  },
  "admin.users.create": {
    label: t("permissions.createUserAccounts"),
    description: t("permissions.createAccountsWithApprovedRolesAndAPersonalMailbox"),
    group: "users",
    requires: userRead,
  },
  "admin.users.profile.update": {
    label: t("permissions.editUserProfiles"),
    description: t("permissions.changeUserDisplayNamesAndProfilePhotos"),
    group: "users",
    requires: userRead,
  },
  "admin.users.email.update": {
    label: t("permissions.changeLoginEmailAddresses"),
    description: t("permissions.changeAUserSSignInAddress"),
    group: "security",
    requires: userRead,
    impact: t("permissions.endsTheUserSSessions"),
  },
  "admin.users.status.update": {
    label: t("permissions.enableOrDisableAccounts"),
    description: t("permissions.changeAccountAvailabilityYouCannotDisableYourOwnAccount"),
    group: "security",
    requires: userRead,
    impact: t("permissions.endsTheUserSSessions"),
  },
  "admin.users.credentials.reset": {
    label: t("permissions.resetUserPasswords"),
    description: t("permissions.setTemporaryPasswordsAndChangeThePasswordChangeRequirement"),
    group: "security",
    requires: userRead,
    impact: t("permissions.endsTheUserSSessions"),
  },
  "admin.users.delete": {
    label: t("permissions.deleteUserAccounts"),
    description: t("permissions.removeAccountsAndRevokeTheirCredentials"),
    group: "security",
    requires: userRead,
    impact: t("permissions.removesWorkspaceAccess"),
  },
  "admin.roles.read": {
    label: t("permissions.viewRolesAndPermissions"),
    description: t("permissions.viewRoleDefinitionsMembershipCountsAndThePermissionCatalog"),
    group: "roles",
    requires: ["console.access"],
  },
  "admin.roles.create": {
    label: t("permissions.createRoles"),
    description: t("permissions.createRolesUsingPermissionsYouHold"),
    group: "roles",
    requires: roleRead,
  },
  "admin.roles.update": {
    label: t("permissions.editRoles"),
    description: t("permissions.editCustomRolesWhosePermissionsYouHold"),
    group: "roles",
    requires: roleRead,
    impact: t("permissions.changesEveryAssignedUserSAccessImmediately"),
  },
  "admin.roles.delete": {
    label: t("permissions.deleteRoles"),
    description: t("permissions.deleteCustomRolesWhosePermissionsYouHold"),
    group: "roles",
    requires: roleRead,
    impact: t("permissions.removesTheRoleFromAllAssignedUsers"),
  },
  "admin.roles.defaults.manage": {
    label: t("permissions.manageDefaultRoles"),
    description: t("permissions.chooseServiceOnlyRolesSelectedForNewUsersExisting"),
    group: "roles",
    requires: roleRead,
  },
  "admin.users.roles.read": {
    label: t("permissions.viewAssignedRoles"),
    description: t("permissions.inspectAUserSRoleAssignmentsAndTheAccess"),
    group: "assignments",
    requires: ["admin.users.read", "admin.roles.read"],
  },
  "admin.users.roles.assign": {
    label: t("permissions.assignRoles"),
    description: t("permissions.addRolesWhosePermissionsYouHoldToAUser"),
    group: "assignments",
    requires: assignmentRead,
    impact: t("permissions.grantsAccessImmediately"),
  },
  "admin.users.roles.remove": {
    label: t("permissions.removeAssignedRoles"),
    description: t("permissions.removeRolesWhosePermissionsYouHoldFromAUser"),
    group: "assignments",
    requires: assignmentRead,
    impact: t("permissions.revokesAccessImmediately"),
  },
  "admin.mail.providers.read": {
    label: t("permissions.viewSendingProviderSettings"),
    description: t("permissions.inspectSendingProviderSettingsFromMailDomainConfiguration"),
    group: "mail",
    requires: ["console.access"],
  },
  "admin.mail.providers.manage": {
    label: t("permissions.manageSendingProviders"),
    description: t("permissions.configureDomainSpecificSendingProvidersWhileManagingMailDomains"),
    group: "mail",
    requires: ["admin.mail.providers.read"],
  },
  "admin.mail.domains.read": {
    label: t("permissions.viewMailDomains"),
    description: t("permissions.inspectMailDomainsAndInboundRoutingConfiguration"),
    group: "mail",
    requires: ["console.access"],
  },
  "admin.mail.domains.manage": {
    label: t("permissions.manageMailDomains"),
    description: t("permissions.configureDomainsAddressesAndInboundRouting"),
    group: "mail",
    requires: ["admin.mail.domains.read"],
  },
  "admin.mail.mailboxes.read": {
    label: t("permissions.viewMailboxConfiguration"),
    description: t("permissions.listWorkspaceMailboxConfigurationWithoutAccessToMessageContents"),
    group: "mail",
    requires: ["console.access"],
  },
  "admin.mail.mailboxes.manage": {
    label: t("permissions.manageMailboxConfiguration"),
    description: t("permissions.provisionMailboxesAndChangeTheirStatusDoesNotGrant"),
    group: "mail",
    requires: ["admin.mail.mailboxes.read"],
  },
  "admin.mail.audit.read": {
    label: t("permissions.viewMailAuditHistory"),
    description: t("permissions.inspectResourceActivityForMailboxesYouManageDoesNot"),
    group: "mail",
    requires: ["console.access", "mail.access"],
  },
} as const satisfies Record<string, PermissionDefinition>;
export type Permission = keyof typeof permissionCatalog;
export const ADMINISTRATOR_ROLE_ID = "system-administrator";
export const MAIL_USER_ROLE_ID = "system-mail-user";
export const calendarUserPermissions = [
  "calendar.access",
  "calendar.calendars.create",
  "calendar.events.create",
  "calendar.events.update",
  "calendar.events.delete",
  "calendar.sharing.internal",
  "calendar.sharing.external",
  "calendar.events.invite",
  "calendar.groups.manage",
] as const;
export const driveUserPermissions = [
  "drive.access",
  "drive.files.create",
  "drive.files.update",
  "drive.files.delete",
  "drive.files.download",
  "drive.comments.create",
  "drive.sharing.internal",
  "drive.sharing.public",
] as const;
export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && Object.hasOwn(permissionCatalog, value);
}
export function permissionClosure(values: readonly string[]): Permission[] {
  const result = new Set<Permission>();
  const visit = (key: string) => {
    if (!isPermission(key) || result.has(key)) return;
    result.add(key);
    for (const parent of permissionCatalog[key].requires) visit(parent);
  };
  values.forEach(visit);
  return [...result];
}
export function missingPrerequisites(values: readonly string[]): Permission[] {
  return permissionClosure(values).filter((key) => !values.includes(key));
}
export function effectivePermissions(values: readonly string[]): Permission[] {
  return values
    .filter(isPermission)
    .filter((key) => permissionClosure([key]).every((required) => values.includes(required)));
}
export function togglePermission(
  values: readonly string[],
  key: string,
  checked: boolean,
): Permission[] {
  if (checked) return permissionClosure([...values, key]);
  return values
    .filter(isPermission)
    .filter((value) => !permissionClosure([value]).includes(key as Permission));
}
export function defaultEligible(values: readonly string[]): boolean {
  return values.every((key) =>
    ["mail.access", ...calendarUserPermissions, ...driveUserPermissions].includes(
      key as (typeof driveUserPermissions)[number],
    ),
  );
}
export interface ResourceRef {
  type: string;
  id: string;
}
