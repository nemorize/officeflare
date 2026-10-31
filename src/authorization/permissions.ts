import { t } from "../../shared/i18n/index.ts";
export const permissionGroups = {
  get services() {
    return t("permissions.serviceAccess");
  },
  get users() {
    return t("permissions.userAdministration");
  },
  get security() {
    return t("permissions.accountSecurity");
  },
  get roles() {
    return t("permissions.roleAdministration");
  },
  get assignments() {
    return t("permissions.roleAssignments");
  },
  get mail() {
    return t("permissions.mailAdministration");
  },
  get drive() {
    return t("permissions.driveUsage");
  },
  get driveAdmin() {
    return t("permissions.driveAdministration");
  },
  get calendar() {
    return t("permissions.calendarUsage");
  },
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
    get label() {
      return t("permissions.accessConsole");
    },
    get description() {
      return t("permissions.openSystemSettingsManagementActionsRequireTheirOwnPermissions");
    },
    group: "services",
    requires: [],
  },
  "mail.access": {
    get label() {
      return t("permissions.accessMail");
    },
    get description() {
      return t("permissions.useMailWithOwnedOrExplicitlySharedMailboxesDoes");
    },
    group: "services",
    requires: [],
  },
  "calendar.access": {
    get label() {
      return t("permissions.accessCalendar");
    },
    get description() {
      return t("permissions.openTheCalendarWorkspace");
    },
    group: "services",
    requires: [],
  },
  "calendar.calendars.create": {
    get label() {
      return t("permissions.createCalendars");
    },
    get description() {
      return t("permissions.createAdditionalCalendarsSharingRemainsSubjectToCalendarAccess");
    },
    group: "calendar",
    requires: ["calendar.access"],
  },
  "calendar.events.create": {
    get label() {
      return t("permissions.createCalendarEvents");
    },
    get description() {
      return t("permissions.createAndDuplicateEventsInCalendarsWhereYouHave");
    },
    group: "calendar",
    requires: ["calendar.access"],
  },
  "calendar.events.update": {
    get label() {
      return t("permissions.editCalendarEvents");
    },
    get description() {
      return t("permissions.editMoveAndRestoreEventsWhereCalendarWritingAccess");
    },
    group: "calendar",
    requires: ["calendar.access"],
  },
  "calendar.events.delete": {
    get label() {
      return t("permissions.deleteCalendarEvents");
    },
    get description() {
      return t("permissions.cancelEventsAndRecurringOccurrencesWhereCalendarWritingAccess");
    },
    group: "calendar",
    requires: ["calendar.access"],
  },
  "calendar.sharing.internal": {
    get label() {
      return t("permissions.shareCalendarsInternally");
    },
    get description() {
      return t("permissions.manageCalendarGrantsWhereYouHaveManagementAccess");
    },
    group: "calendar",
    requires: ["calendar.access"],
  },
  "calendar.sharing.external": {
    get label() {
      return t("permissions.shareCalendarLinks");
    },
    get description() {
      return t("permissions.createAndManageExternalViewingAndRegistrationLinks");
    },
    group: "calendar",
    requires: ["calendar.access"],
  },
  "calendar.events.invite": {
    get label() {
      return t("permissions.inviteCalendarAttendees");
    },
    get description() {
      return t("permissions.invitePeopleAndManageRegistrationsInWritableEvents");
    },
    group: "calendar",
    requires: ["calendar.access"],
  },
  "calendar.groups.manage": {
    get label() {
      return t("permissions.manageCalendarGroups");
    },
    get description() {
      return t("permissions.manageGroupsOwnedByYourAccount");
    },
    group: "calendar",
    requires: ["calendar.access"],
  },
  "admin.calendar.settings.read": {
    get label() {
      return t("permissions.readCalendarSettings");
    },
    get description() {
      return t("permissions.readWorkspaceSharingAndSystemSenderSettings");
    },
    group: "calendar",
    requires: ["console.access"],
  },
  "admin.calendar.settings.manage": {
    get label() {
      return t("permissions.manageCalendarSettings");
    },
    get description() {
      return t("permissions.changeWorkspaceSharingPolicyAndTheSystemInvitationSender");
    },
    group: "calendar",
    requires: ["admin.calendar.settings.read"],
  },
  "drive.access": {
    get label() {
      return t("permissions.accessDrive");
    },
    get description() {
      return t("permissions.useOwnedAndExplicitlySharedFilesAndFoldersDoes");
    },
    group: "services",
    requires: [],
  },
  "drive.files.create": {
    get label() {
      return t("permissions.createDriveFilesAndFolders");
    },
    get description() {
      return t("permissions.uploadFilesCreateFoldersAndCopyAccessibleItemsFolder");
    },
    group: "drive",
    requires: ["drive.access"],
  },
  "drive.files.update": {
    get label() {
      return t("permissions.editDriveFiles");
    },
    get description() {
      return t("permissions.replaceContentRenameMoveRestoreAndManageFileVersions");
    },
    group: "drive",
    requires: ["drive.access"],
  },
  "drive.files.delete": {
    get label() {
      return t("permissions.deleteOwnedDriveItems");
    },
    get description() {
      return t("permissions.trashOwnedItemsAndPermanentlyDeleteItemsAlreadyIn");
    },
    group: "drive",
    requires: ["drive.access"],
  },
  "drive.files.download": {
    get label() {
      return t("permissions.downloadDriveFiles");
    },
    get description() {
      return t("permissions.downloadAndCopyFilesYouOwnOrCanAccess");
    },
    group: "drive",
    requires: ["drive.access"],
  },
  "drive.comments.create": {
    get label() {
      return t("permissions.commentInDrive");
    },
    get description() {
      return t("permissions.addAndManageCommentsWhereTheItemSharingRole");
    },
    group: "drive",
    requires: ["drive.access"],
  },
  "drive.sharing.internal": {
    get label() {
      return t("permissions.shareDriveItemsInternally");
    },
    get description() {
      return t("permissions.shareOwnedItemsWithWorkspaceAccountsAndTransferOwnership");
    },
    group: "drive",
    requires: ["drive.access"],
  },
  "drive.sharing.public": {
    get label() {
      return t("permissions.createPublicDriveLinks");
    },
    get description() {
      return t("permissions.createAndUpdatePublicLinksForOwnedItemsSubject");
    },
    group: "drive",
    requires: ["drive.access"],
    get impact() {
      return t("permissions.allowsExternalAccessToSharedFiles");
    },
  },
  "admin.drive.settings.read": {
    get label() {
      return t("permissions.viewDriveSettings");
    },
    get description() {
      return t("permissions.inspectWorkspaceStorageSharingAndRetentionPolicies");
    },
    group: "driveAdmin",
    requires: ["console.access"],
  },
  "admin.drive.settings.manage": {
    get label() {
      return t("permissions.manageDriveSettings");
    },
    get description() {
      return t("permissions.changeWorkspaceDrivePoliciesAndDefaultStorageLimits");
    },
    group: "driveAdmin",
    requires: ["admin.drive.settings.read"],
    get impact() {
      return t("permissions.changesApplyToExistingLinksAndAccountsUsingDefaults");
    },
  },
  "admin.drive.accounts.read": {
    get label() {
      return t("permissions.viewDriveAccounts");
    },
    get description() {
      return t("permissions.inspectUserStorageUsageLimitsAndDriveAvailabilityIncluding");
    },
    group: "driveAdmin",
    requires: ["console.access"],
  },
  "admin.drive.accounts.manage": {
    get label() {
      return t("permissions.manageDriveAccounts");
    },
    get description() {
      return t("permissions.setStorageOverridesAndSuspendOrRestrictDriveWrites");
    },
    group: "driveAdmin",
    requires: ["admin.drive.accounts.read"],
  },
  "admin.drive.items.read": {
    get label() {
      return t("permissions.viewDriveInventory");
    },
    get description() {
      return t("permissions.inspectFileAndFolderMetadataAndTrashDoesNot");
    },
    group: "driveAdmin",
    requires: ["console.access"],
  },
  "admin.drive.sharing.read": {
    get label() {
      return t("permissions.viewDriveSharing");
    },
    get description() {
      return t("permissions.inspectInternalGrantsAndPublicLinkMetadataAcrossThe");
    },
    group: "driveAdmin",
    requires: ["console.access"],
  },
  "admin.drive.sharing.manage": {
    get label() {
      return t("permissions.manageDriveSharing");
    },
    get description() {
      return t("permissions.changeOrRevokeInternalGrantsAndRevokePublicLinks");
    },
    group: "driveAdmin",
    requires: ["admin.drive.sharing.read", "admin.drive.accounts.read"],
    get impact() {
      return t("permissions.changesRecipientsAccess");
    },
  },
  "admin.drive.audit.read": {
    get label() {
      return t("permissions.viewDriveAuditLogs");
    },
    get description() {
      return t("permissions.searchFileActivityAndImmutableAdministratorRecordsAcrossThe");
    },
    group: "driveAdmin",
    requires: ["console.access"],
  },
  "admin.drive.ownership.transfer": {
    get label() {
      return t("permissions.transferDriveOwnership");
    },
    get description() {
      return t("permissions.handOverFilesOrAnAccountSInventoryIncluding");
    },
    group: "driveAdmin",
    requires: ["admin.drive.accounts.read", "admin.drive.items.read"],
    get impact() {
      return t("permissions.grantsTheRecipientOwnershipAndRevokesPublicLinks");
    },
  },
  "admin.drive.trash.restore": {
    get label() {
      return t("permissions.restoreDriveTrash");
    },
    get description() {
      return t("permissions.restoreTrashedItemsWithoutOpeningFileContents");
    },
    group: "driveAdmin",
    requires: ["admin.drive.items.read"],
  },
  "admin.drive.trash.purge": {
    get label() {
      return t("permissions.permanentlyDeleteDriveTrash");
    },
    get description() {
      return t("permissions.permanentlyDeleteItemsAlreadyInTrashAndQueueTheir");
    },
    group: "driveAdmin",
    requires: ["admin.drive.items.read"],
    get impact() {
      return t("permissions.permanentlyRemovesFilesAndTheirVersions");
    },
  },
  "admin.users.read": {
    get label() {
      return t("permissions.viewAdministrativeUserRecords");
    },
    get description() {
      return t("permissions.inspectAccountDetailsStatusAndSignInActivityIn");
    },
    group: "users",
    requires: ["console.access"],
  },
  "admin.users.create": {
    get label() {
      return t("permissions.createUserAccounts");
    },
    get description() {
      return t("permissions.createAccountsWithApprovedRolesAndAPersonalMailbox");
    },
    group: "users",
    requires: userRead,
  },
  "admin.users.profile.update": {
    get label() {
      return t("permissions.editUserProfiles");
    },
    get description() {
      return t("permissions.changeUserDisplayNamesAndProfilePhotos");
    },
    group: "users",
    requires: userRead,
  },
  "admin.users.email.update": {
    get label() {
      return t("permissions.changeLoginEmailAddresses");
    },
    get description() {
      return t("permissions.changeAUserSSignInAddress");
    },
    group: "security",
    requires: userRead,
    get impact() {
      return t("permissions.endsTheUserSSessions");
    },
  },
  "admin.users.status.update": {
    get label() {
      return t("permissions.enableOrDisableAccounts");
    },
    get description() {
      return t("permissions.changeAccountAvailabilityYouCannotDisableYourOwnAccount");
    },
    group: "security",
    requires: userRead,
    get impact() {
      return t("permissions.endsTheUserSSessions");
    },
  },
  "admin.users.credentials.reset": {
    get label() {
      return t("permissions.resetUserPasswords");
    },
    get description() {
      return t("permissions.setTemporaryPasswordsAndChangeThePasswordChangeRequirement");
    },
    group: "security",
    requires: userRead,
    get impact() {
      return t("permissions.endsTheUserSSessions");
    },
  },
  "admin.users.delete": {
    get label() {
      return t("permissions.deleteUserAccounts");
    },
    get description() {
      return t("permissions.removeAccountsAndRevokeTheirCredentials");
    },
    group: "security",
    requires: userRead,
    get impact() {
      return t("permissions.removesWorkspaceAccess");
    },
  },
  "admin.roles.read": {
    get label() {
      return t("permissions.viewRolesAndPermissions");
    },
    get description() {
      return t("permissions.viewRoleDefinitionsMembershipCountsAndThePermissionCatalog");
    },
    group: "roles",
    requires: ["console.access"],
  },
  "admin.roles.create": {
    get label() {
      return t("permissions.createRoles");
    },
    get description() {
      return t("permissions.createRolesUsingPermissionsYouHold");
    },
    group: "roles",
    requires: roleRead,
  },
  "admin.roles.update": {
    get label() {
      return t("permissions.editRoles");
    },
    get description() {
      return t("permissions.editCustomRolesWhosePermissionsYouHold");
    },
    group: "roles",
    requires: roleRead,
    get impact() {
      return t("permissions.changesEveryAssignedUserSAccessImmediately");
    },
  },
  "admin.roles.delete": {
    get label() {
      return t("permissions.deleteRoles");
    },
    get description() {
      return t("permissions.deleteCustomRolesWhosePermissionsYouHold");
    },
    group: "roles",
    requires: roleRead,
    get impact() {
      return t("permissions.removesTheRoleFromAllAssignedUsers");
    },
  },
  "admin.roles.defaults.manage": {
    get label() {
      return t("permissions.manageDefaultRoles");
    },
    get description() {
      return t("permissions.chooseServiceOnlyRolesSelectedForNewUsersExisting");
    },
    group: "roles",
    requires: roleRead,
  },
  "admin.users.roles.read": {
    get label() {
      return t("permissions.viewAssignedRoles");
    },
    get description() {
      return t("permissions.inspectAUserSRoleAssignmentsAndTheAccess");
    },
    group: "assignments",
    requires: ["admin.users.read", "admin.roles.read"],
  },
  "admin.users.roles.assign": {
    get label() {
      return t("permissions.assignRoles");
    },
    get description() {
      return t("permissions.addRolesWhosePermissionsYouHoldToAUser");
    },
    group: "assignments",
    requires: assignmentRead,
    get impact() {
      return t("permissions.grantsAccessImmediately");
    },
  },
  "admin.users.roles.remove": {
    get label() {
      return t("permissions.removeAssignedRoles");
    },
    get description() {
      return t("permissions.removeRolesWhosePermissionsYouHoldFromAUser");
    },
    group: "assignments",
    requires: assignmentRead,
    get impact() {
      return t("permissions.revokesAccessImmediately");
    },
  },
  "admin.mail.providers.read": {
    get label() {
      return t("permissions.viewSendingProviderSettings");
    },
    get description() {
      return t("permissions.inspectSendingProviderSettingsFromMailDomainConfiguration");
    },
    group: "mail",
    requires: ["console.access"],
  },
  "admin.mail.providers.manage": {
    get label() {
      return t("permissions.manageSendingProviders");
    },
    get description() {
      return t("permissions.configureDomainSpecificSendingProvidersWhileManagingMailDomains");
    },
    group: "mail",
    requires: ["admin.mail.providers.read"],
  },
  "admin.mail.domains.read": {
    get label() {
      return t("permissions.viewMailDomains");
    },
    get description() {
      return t("permissions.inspectMailDomainsAndInboundRoutingConfiguration");
    },
    group: "mail",
    requires: ["console.access"],
  },
  "admin.mail.domains.manage": {
    get label() {
      return t("permissions.manageMailDomains");
    },
    get description() {
      return t("permissions.configureDomainsAddressesAndInboundRouting");
    },
    group: "mail",
    requires: ["admin.mail.domains.read"],
  },
  "admin.mail.mailboxes.read": {
    get label() {
      return t("permissions.viewMailboxConfiguration");
    },
    get description() {
      return t("permissions.listWorkspaceMailboxConfigurationWithoutAccessToMessageContents");
    },
    group: "mail",
    requires: ["console.access"],
  },
  "admin.mail.mailboxes.manage": {
    get label() {
      return t("permissions.manageMailboxConfiguration");
    },
    get description() {
      return t("permissions.provisionMailboxesAndChangeTheirStatusDoesNotGrant");
    },
    group: "mail",
    requires: ["admin.mail.mailboxes.read"],
  },
  "admin.mail.audit.read": {
    get label() {
      return t("permissions.viewMailAuditHistory");
    },
    get description() {
      return t("permissions.inspectResourceActivityForMailboxesYouManageDoesNot");
    },
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
