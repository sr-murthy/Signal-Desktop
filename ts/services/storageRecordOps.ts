// Copyright 2020 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { isEqual } from 'lodash';
import Long from 'long';

import { uuidToBytes, bytesToUuid } from '../util/uuidToBytes';
import { deriveMasterKeyFromGroupV1 } from '../Crypto';
import * as Bytes from '../Bytes';
import {
  deriveGroupFields,
  waitThenMaybeUpdateGroup,
  waitThenRespondToGroupV2Migration,
} from '../groups';
import { assertDev, strictAssert } from '../util/assert';
import { dropNull } from '../util/dropNull';
import { missingCaseError } from '../util/missingCaseError';
import { isNotNil } from '../util/isNotNil';
import {
  PhoneNumberSharingMode,
  parsePhoneNumberSharingMode,
} from '../util/phoneNumberSharingMode';
import {
  PhoneNumberDiscoverability,
  parsePhoneNumberDiscoverability,
} from '../util/phoneNumberDiscoverability';
import { arePinnedConversationsEqual } from '../util/arePinnedConversationsEqual';
import type { ConversationModel } from '../models/conversations';
import {
  getSafeLongFromTimestamp,
  getTimestampFromLong,
} from '../util/timestampLongUtils';
import { canHaveUsername } from '../util/getTitle';
import {
  get as getUniversalExpireTimer,
  set as setUniversalExpireTimer,
} from '../util/universalExpireTimer';
import { ourProfileKeyService } from './ourProfileKey';
import { isGroupV1, isGroupV2 } from '../util/whatTypeOfConversation';
import { DurationInSeconds } from '../util/durations';
import * as preferredReactionEmoji from '../reactions/preferredReactionEmoji';
import { SignalService as Proto } from '../protobuf';
import { createLogger } from '../logging/log';
import { normalizeStoryDistributionId } from '../types/StoryDistributionId';
import type { StoryDistributionIdString } from '../types/StoryDistributionId';
import type { ServiceIdString } from '../types/ServiceId';
import {
  ServiceIdKind,
  normalizeServiceId,
  toUntaggedPni,
} from '../types/ServiceId';
import { isAciString } from '../util/isAciString';
import * as Stickers from '../types/Stickers';
import type {
  StoryDistributionWithMembersType,
  StickerPackInfoType,
} from '../sql/Interface';
import { DataReader, DataWriter } from '../sql/Client';
import { MY_STORY_ID, StorySendMode } from '../types/Stories';
import { findAndDeleteOnboardingStoryIfExists } from '../util/findAndDeleteOnboardingStoryIfExists';
import { downloadOnboardingStory } from '../util/downloadOnboardingStory';
import { drop } from '../util/drop';
import { redactExtendedStorageID } from '../util/privacy';
import type {
  CallLinkRecord,
  DefunctCallLinkType,
  PendingCallLinkType,
} from '../types/CallLink';
import {
  callLinkFromRecord,
  fromRootKeyBytes,
  getRoomIdFromRootKeyString,
  toRootKeyBytes,
} from '../util/callLinksRingrtc';
import { fromAdminKeyBytes, toAdminKeyBytes } from '../util/callLinks';
import { isOlderThan } from '../util/timestamp';
import { getMessageQueueTime } from '../util/getMessageQueueTime';
import { callLinkRefreshJobQueue } from '../jobs/callLinkRefreshJobQueue';
import {
  generateBackupsSubscriberData,
  saveBackupsSubscriberData,
  saveBackupTier,
} from '../util/backupSubscriptionData';
import {
  toAciObject,
  toPniObject,
  toServiceIdObject,
  fromServiceIdBinaryOrString,
  fromAciUuidBytesOrString,
  fromPniUuidBytesOrUntaggedString,
} from '../util/ServiceId';
import { isProtoBinaryEncodingEnabled } from '../util/isProtoBinaryEncodingEnabled';
import { getLinkPreviewSetting } from '../types/LinkPreview';
import {
  getReadReceiptSetting,
  getSealedSenderIndicatorSetting,
  getTypingIndicatorSetting,
} from '../types/Util';
import { MessageRequestResponseSource } from '../types/MessageRequestResponseEvent';

const log = createLogger('storageRecordOps');

const MY_STORY_BYTES = uuidToBytes(MY_STORY_ID);

type RecordClass =
  | Proto.IAccountRecord
  | Proto.IContactRecord
  | Proto.IGroupV1Record
  | Proto.IGroupV2Record;

export type MergeResultType = Readonly<{
  shouldDrop?: boolean;
  conversation?: ConversationModel;
  needsProfileFetch?: boolean;
  updatedConversations?: ReadonlyArray<ConversationModel>;
  oldStorageID?: string;
  oldStorageVersion?: number;
  details: ReadonlyArray<string>;
}>;

function toRecordVerified(verified: number): Proto.ContactRecord.IdentityState {
  const VERIFIED_ENUM = window.textsecure.storage.protocol.VerifiedStatus;
  const STATE_ENUM = Proto.ContactRecord.IdentityState;

  switch (verified) {
    case VERIFIED_ENUM.VERIFIED:
      return STATE_ENUM.VERIFIED;
    case VERIFIED_ENUM.UNVERIFIED:
      return STATE_ENUM.UNVERIFIED;
    default:
      return STATE_ENUM.DEFAULT;
  }
}

function fromRecordVerified(
  verified: Proto.ContactRecord.IdentityState
): number {
  const VERIFIED_ENUM = window.textsecure.storage.protocol.VerifiedStatus;
  const STATE_ENUM = Proto.ContactRecord.IdentityState;

  switch (verified) {
    case STATE_ENUM.VERIFIED:
      return VERIFIED_ENUM.VERIFIED;
    case STATE_ENUM.UNVERIFIED:
      return VERIFIED_ENUM.UNVERIFIED;
    default:
      return VERIFIED_ENUM.DEFAULT;
  }
}

function fromAvatarColor(
  color: Proto.AvatarColor | null | undefined
): string | undefined {
  switch (color) {
    case Proto.AvatarColor.A100:
      return 'A100';
    case Proto.AvatarColor.A110:
      return 'A110';
    case Proto.AvatarColor.A120:
      return 'A120';
    case Proto.AvatarColor.A130:
      return 'A130';
    case Proto.AvatarColor.A140:
      return 'A140';
    case Proto.AvatarColor.A150:
      return 'A150';
    case Proto.AvatarColor.A160:
      return 'A160';
    case Proto.AvatarColor.A170:
      return 'A170';
    case Proto.AvatarColor.A180:
      return 'A180';
    case Proto.AvatarColor.A190:
      return 'A190';
    case Proto.AvatarColor.A200:
      return 'A200';
    case Proto.AvatarColor.A210:
      return 'A210';
    case undefined:
    case null:
      return undefined;
    default:
      throw missingCaseError(color);
  }
}

function applyAvatarColor(
  conversation: ConversationModel,
  protoColor: Proto.AvatarColor | null | undefined
): void {
  conversation.set({
    colorFromPrimary: dropNull(protoColor),
    color: fromAvatarColor(protoColor) ?? conversation.get('color'),
  });
}

function addUnknownFields(
  record: RecordClass,
  conversation: ConversationModel,
  details: Array<string>
): void {
  if (record.$unknownFields) {
    details.push('adding unknown fields');
    conversation.set({
      storageUnknownFields: Bytes.toBase64(
        Bytes.concatenate(record.$unknownFields)
      ),
    });
  } else if (conversation.get('storageUnknownFields')) {
    // If the record doesn't have unknown fields attached but we have them
    // saved locally then we need to clear it out
    details.push('clearing unknown fields');
    conversation.unset('storageUnknownFields');
  }
}

function applyUnknownFields(
  record: RecordClass,
  conversation: ConversationModel
): void {
  const storageUnknownFields = conversation.get('storageUnknownFields');
  if (storageUnknownFields) {
    log.info(
      'storageService.applyUnknownFields: Applying unknown fields for',
      conversation.idForLogging()
    );
    // eslint-disable-next-line no-param-reassign
    record.$unknownFields = [Bytes.fromBase64(storageUnknownFields)];
  }
}

export async function toContactRecord(
  conversation: ConversationModel
): Promise<Proto.ContactRecord> {
  const contactRecord = new Proto.ContactRecord();
  const aci = conversation.getAci();
  if (aci) {
    if (isProtoBinaryEncodingEnabled()) {
      contactRecord.aciBinary = toAciObject(aci).getRawUuidBytes();
    } else {
      contactRecord.aci = aci;
    }
  }
  const e164 = conversation.get('e164');
  if (e164) {
    contactRecord.e164 = e164;
  }
  const username = conversation.get('username');
  const ourID = window.ConversationController.getOurConversationId();
  if (username && canHaveUsername(conversation.attributes, ourID)) {
    contactRecord.username = username;
  }
  const pni = conversation.getPni();
  if (pni) {
    if (isProtoBinaryEncodingEnabled()) {
      contactRecord.pniBinary = toPniObject(pni).getRawUuidBytes();
    } else {
      contactRecord.pni = toUntaggedPni(pni);
    }
  }
  contactRecord.pniSignatureVerified =
    conversation.get('pniSignatureVerified') ?? false;
  const profileKey = conversation.get('profileKey');
  if (profileKey) {
    contactRecord.profileKey = Bytes.fromBase64(String(profileKey));
  }

  const serviceId = aci ?? pni;
  const identityKey = serviceId
    ? await window.textsecure.storage.protocol.loadIdentityKey(serviceId)
    : undefined;
  if (identityKey) {
    contactRecord.identityKey = identityKey;
  }
  const verified = conversation.get('verified');
  if (verified) {
    contactRecord.identityState = toRecordVerified(Number(verified));
  }
  const profileName = conversation.get('profileName');
  if (profileName) {
    contactRecord.givenName = profileName;
  }
  const profileFamilyName = conversation.get('profileFamilyName');
  if (profileFamilyName) {
    contactRecord.familyName = profileFamilyName;
  }
  const nicknameGivenName = conversation.get('nicknameGivenName');
  const nicknameFamilyName = conversation.get('nicknameFamilyName');
  if (nicknameGivenName || nicknameFamilyName) {
    contactRecord.nickname = {
      given: nicknameGivenName,
      family: nicknameFamilyName,
    };
  }
  const note = conversation.get('note');
  if (note) {
    contactRecord.note = note;
  }
  const systemGivenName = conversation.get('systemGivenName');
  if (systemGivenName) {
    contactRecord.systemGivenName = systemGivenName;
  }
  const systemFamilyName = conversation.get('systemFamilyName');
  if (systemFamilyName) {
    contactRecord.systemFamilyName = systemFamilyName;
  }
  const systemNickname = conversation.get('systemNickname');
  if (systemNickname) {
    contactRecord.systemNickname = systemNickname;
  }
  contactRecord.blocked = conversation.isBlocked();
  contactRecord.hidden = conversation.get('removalStage') !== undefined;
  contactRecord.whitelisted = Boolean(conversation.get('profileSharing'));
  contactRecord.archived = Boolean(conversation.get('isArchived'));
  contactRecord.markedUnread = Boolean(conversation.get('markedUnread'));
  contactRecord.mutedUntilTimestamp = getSafeLongFromTimestamp(
    conversation.get('muteExpiresAt'),
    Long.MAX_VALUE
  );
  if (conversation.get('hideStory') !== undefined) {
    contactRecord.hideStory = Boolean(conversation.get('hideStory'));
  }
  contactRecord.unregisteredAtTimestamp = getSafeLongFromTimestamp(
    conversation.get('firstUnregisteredAt')
  );
  const avatarColor = conversation.get('colorFromPrimary');
  if (avatarColor != null) {
    contactRecord.avatarColor = avatarColor;
  }

  applyUnknownFields(contactRecord, conversation);

  return contactRecord;
}

export function toAccountRecord(
  conversation: ConversationModel
): Proto.AccountRecord {
  const accountRecord = new Proto.AccountRecord();

  if (conversation.get('profileKey')) {
    accountRecord.profileKey = Bytes.fromBase64(
      String(conversation.get('profileKey'))
    );
  }
  if (conversation.get('profileName')) {
    accountRecord.givenName = conversation.get('profileName') || '';
  }
  if (conversation.get('profileFamilyName')) {
    accountRecord.familyName = conversation.get('profileFamilyName') || '';
  }
  const avatarUrl = window.storage.get('avatarUrl');
  if (avatarUrl !== undefined) {
    accountRecord.avatarUrlPath = avatarUrl;
  }
  const username = conversation.get('username');
  if (username !== undefined) {
    accountRecord.username = username;
  }
  accountRecord.noteToSelfArchived = Boolean(conversation.get('isArchived'));
  accountRecord.noteToSelfMarkedUnread = Boolean(
    conversation.get('markedUnread')
  );
  accountRecord.readReceipts = getReadReceiptSetting();
  accountRecord.sealedSenderIndicators = getSealedSenderIndicatorSetting();
  accountRecord.typingIndicators = getTypingIndicatorSetting();
  accountRecord.linkPreviews = getLinkPreviewSetting();

  const preferContactAvatars = window.storage.get('preferContactAvatars');
  if (preferContactAvatars !== undefined) {
    accountRecord.preferContactAvatars = Boolean(preferContactAvatars);
  }

  const rawPreferredReactionEmoji = window.storage.get(
    'preferredReactionEmoji'
  );
  if (preferredReactionEmoji.canBeSynced(rawPreferredReactionEmoji)) {
    accountRecord.preferredReactionEmoji = rawPreferredReactionEmoji;
  }

  const universalExpireTimer = getUniversalExpireTimer();
  if (universalExpireTimer) {
    accountRecord.universalExpireTimer = Number(universalExpireTimer);
  }

  const PHONE_NUMBER_SHARING_MODE_ENUM =
    Proto.AccountRecord.PhoneNumberSharingMode;
  const phoneNumberSharingMode = parsePhoneNumberSharingMode(
    window.storage.get('phoneNumberSharingMode')
  );
  switch (phoneNumberSharingMode) {
    case PhoneNumberSharingMode.Everybody:
      accountRecord.phoneNumberSharingMode =
        PHONE_NUMBER_SHARING_MODE_ENUM.EVERYBODY;
      break;
    case PhoneNumberSharingMode.ContactsOnly:
    case PhoneNumberSharingMode.Nobody:
      accountRecord.phoneNumberSharingMode =
        PHONE_NUMBER_SHARING_MODE_ENUM.NOBODY;
      break;
    default:
      throw missingCaseError(phoneNumberSharingMode);
  }

  const phoneNumberDiscoverability = parsePhoneNumberDiscoverability(
    window.storage.get('phoneNumberDiscoverability')
  );
  switch (phoneNumberDiscoverability) {
    case PhoneNumberDiscoverability.Discoverable:
      accountRecord.unlistedPhoneNumber = false;
      break;
    case PhoneNumberDiscoverability.NotDiscoverable:
      accountRecord.unlistedPhoneNumber = true;
      break;
    default:
      throw missingCaseError(phoneNumberDiscoverability);
  }

  const pinnedConversations = window.storage
    .get('pinnedConversationIds', new Array<string>())
    .map(id => {
      const pinnedConversation = window.ConversationController.get(id);

      if (pinnedConversation) {
        const pinnedConversationRecord =
          new Proto.AccountRecord.PinnedConversation();

        if (pinnedConversation.get('type') === 'private') {
          const serviceId = pinnedConversation.getServiceId();
          pinnedConversationRecord.identifier = 'contact';
          pinnedConversationRecord.contact = {
            ...(isProtoBinaryEncodingEnabled()
              ? {
                  serviceIdBinary:
                    serviceId == null
                      ? null
                      : toServiceIdObject(serviceId).getServiceIdBinary(),
                }
              : {
                  serviceId,
                }),
            e164: pinnedConversation.get('e164'),
          };
        } else if (isGroupV1(pinnedConversation.attributes)) {
          pinnedConversationRecord.identifier = 'legacyGroupId';
          const groupId = pinnedConversation.get('groupId');
          if (!groupId) {
            throw new Error(
              'toAccountRecord: trying to pin a v1 Group without groupId'
            );
          }
          pinnedConversationRecord.legacyGroupId = Bytes.fromBinary(groupId);
        } else if (isGroupV2(pinnedConversation.attributes)) {
          pinnedConversationRecord.identifier = 'groupMasterKey';
          const masterKey = pinnedConversation.get('masterKey');
          if (!masterKey) {
            throw new Error(
              'toAccountRecord: trying to pin a v2 Group without masterKey'
            );
          }
          pinnedConversationRecord.groupMasterKey = Bytes.fromBase64(masterKey);
        }

        return pinnedConversationRecord;
      }

      return undefined;
    })
    .filter(
      (
        pinnedConversationClass
      ): pinnedConversationClass is Proto.AccountRecord.PinnedConversation =>
        pinnedConversationClass !== undefined
    );

  accountRecord.pinnedConversations = pinnedConversations;

  const subscriberId = window.storage.get('subscriberId');
  if (Bytes.isNotEmpty(subscriberId)) {
    accountRecord.donorSubscriberId = subscriberId;
  }
  const subscriberCurrencyCode = window.storage.get('subscriberCurrencyCode');
  if (typeof subscriberCurrencyCode === 'string') {
    accountRecord.donorSubscriberCurrencyCode = subscriberCurrencyCode;
  }
  const donorSubscriptionManuallyCanceled = window.storage.get(
    'donorSubscriptionManuallyCancelled'
  );
  if (typeof donorSubscriptionManuallyCanceled === 'boolean') {
    accountRecord.donorSubscriptionManuallyCancelled =
      donorSubscriptionManuallyCanceled;
  }

  accountRecord.backupSubscriberData = generateBackupsSubscriberData();
  const backupTier = window.storage.get('backupTier');
  if (backupTier) {
    accountRecord.backupTier = Long.fromNumber(backupTier);
  }

  const displayBadgesOnProfile = window.storage.get('displayBadgesOnProfile');
  if (displayBadgesOnProfile !== undefined) {
    accountRecord.displayBadgesOnProfile = displayBadgesOnProfile;
  }
  const keepMutedChatsArchived = window.storage.get('keepMutedChatsArchived');
  if (keepMutedChatsArchived !== undefined) {
    accountRecord.keepMutedChatsArchived = keepMutedChatsArchived;
  }

  const hasSetMyStoriesPrivacy = window.storage.get('hasSetMyStoriesPrivacy');
  if (hasSetMyStoriesPrivacy !== undefined) {
    accountRecord.hasSetMyStoriesPrivacy = hasSetMyStoriesPrivacy;
  }

  const hasViewedOnboardingStory = window.storage.get(
    'hasViewedOnboardingStory'
  );
  if (hasViewedOnboardingStory !== undefined) {
    accountRecord.hasViewedOnboardingStory = hasViewedOnboardingStory;
  }

  const hasCompletedUsernameOnboarding = window.storage.get(
    'hasCompletedUsernameOnboarding'
  );
  if (hasCompletedUsernameOnboarding !== undefined) {
    accountRecord.hasCompletedUsernameOnboarding =
      hasCompletedUsernameOnboarding;
  }

  const hasSeenGroupStoryEducationSheet = window.storage.get(
    'hasSeenGroupStoryEducationSheet'
  );
  if (hasSeenGroupStoryEducationSheet !== undefined) {
    accountRecord.hasSeenGroupStoryEducationSheet =
      hasSeenGroupStoryEducationSheet;
  }

  const hasStoriesDisabled = window.storage.get('hasStoriesDisabled');
  accountRecord.storiesDisabled = hasStoriesDisabled === true;

  const storyViewReceiptsEnabled = window.storage.get(
    'storyViewReceiptsEnabled'
  );
  if (storyViewReceiptsEnabled !== undefined) {
    accountRecord.storyViewReceiptsEnabled = storyViewReceiptsEnabled
      ? Proto.OptionalBool.ENABLED
      : Proto.OptionalBool.DISABLED;
  } else {
    accountRecord.storyViewReceiptsEnabled = Proto.OptionalBool.UNSET;
  }

  // Username link
  {
    const color = window.storage.get('usernameLinkColor');
    const linkData = window.storage.get('usernameLink');

    if (linkData?.entropy.length && linkData?.serverId.length) {
      accountRecord.usernameLink = {
        color,
        entropy: linkData.entropy,
        serverId: linkData.serverId,
      };
    }
  }

  const avatarColor = conversation.get('colorFromPrimary');
  if (avatarColor != null) {
    accountRecord.avatarColor = avatarColor;
  }

  applyUnknownFields(accountRecord, conversation);

  return accountRecord;
}

export function toGroupV1Record(
  conversation: ConversationModel
): Proto.GroupV1Record {
  const groupV1Record = new Proto.GroupV1Record();

  groupV1Record.id = Bytes.fromBinary(String(conversation.get('groupId')));

  applyUnknownFields(groupV1Record, conversation);

  return groupV1Record;
}

export function toGroupV2Record(
  conversation: ConversationModel
): Proto.GroupV2Record {
  const groupV2Record = new Proto.GroupV2Record();

  const masterKey = conversation.get('masterKey');
  if (masterKey !== undefined) {
    groupV2Record.masterKey = Bytes.fromBase64(masterKey);
  }
  groupV2Record.blocked = conversation.isBlocked();
  groupV2Record.whitelisted = Boolean(conversation.get('profileSharing'));
  groupV2Record.archived = Boolean(conversation.get('isArchived'));
  groupV2Record.markedUnread = Boolean(conversation.get('markedUnread'));
  groupV2Record.mutedUntilTimestamp = getSafeLongFromTimestamp(
    conversation.get('muteExpiresAt'),
    Long.MAX_VALUE
  );
  groupV2Record.dontNotifyForMentionsIfMuted = Boolean(
    conversation.get('dontNotifyForMentionsIfMuted')
  );
  groupV2Record.hideStory = Boolean(conversation.get('hideStory'));
  const storySendMode = conversation.get('storySendMode');
  if (storySendMode !== undefined) {
    if (storySendMode === StorySendMode.IfActive) {
      groupV2Record.storySendMode = Proto.GroupV2Record.StorySendMode.DEFAULT;
    } else if (storySendMode === StorySendMode.Never) {
      groupV2Record.storySendMode = Proto.GroupV2Record.StorySendMode.DISABLED;
    } else if (storySendMode === StorySendMode.Always) {
      groupV2Record.storySendMode = Proto.GroupV2Record.StorySendMode.ENABLED;
    } else {
      throw missingCaseError(storySendMode);
    }
  }

  const avatarColor = conversation.get('colorFromPrimary');
  if (avatarColor != null) {
    groupV2Record.avatarColor = avatarColor;
  }

  applyUnknownFields(groupV2Record, conversation);

  return groupV2Record;
}

export function toStoryDistributionListRecord(
  storyDistributionList: StoryDistributionWithMembersType
): Proto.StoryDistributionListRecord {
  const storyDistributionListRecord = new Proto.StoryDistributionListRecord();

  storyDistributionListRecord.identifier = uuidToBytes(
    storyDistributionList.id
  );
  storyDistributionListRecord.name = storyDistributionList.name;
  storyDistributionListRecord.deletedAtTimestamp = getSafeLongFromTimestamp(
    storyDistributionList.deletedAtTimestamp
  );
  storyDistributionListRecord.allowsReplies = Boolean(
    storyDistributionList.allowsReplies
  );
  storyDistributionListRecord.isBlockList = Boolean(
    storyDistributionList.isBlockList
  );

  if (isProtoBinaryEncodingEnabled()) {
    storyDistributionListRecord.recipientServiceIdsBinary =
      storyDistributionList.members.map(serviceId => {
        return toServiceIdObject(serviceId).getServiceIdBinary();
      });
  } else {
    storyDistributionListRecord.recipientServiceIds =
      storyDistributionList.members;
  }

  if (storyDistributionList.storageUnknownFields) {
    storyDistributionListRecord.$unknownFields = [
      storyDistributionList.storageUnknownFields,
    ];
  }

  return storyDistributionListRecord;
}

export function toStickerPackRecord(
  stickerPack: StickerPackInfoType
): Proto.StickerPackRecord {
  const stickerPackRecord = new Proto.StickerPackRecord();

  stickerPackRecord.packId = Bytes.fromHex(stickerPack.id);

  if (stickerPack.uninstalledAt !== undefined) {
    stickerPackRecord.deletedAtTimestamp = Long.fromNumber(
      stickerPack.uninstalledAt
    );
  } else {
    stickerPackRecord.packKey = Bytes.fromBase64(stickerPack.key);
    if (stickerPack.position) {
      stickerPackRecord.position = stickerPack.position;
    }
  }

  if (stickerPack.storageUnknownFields) {
    stickerPackRecord.$unknownFields = [stickerPack.storageUnknownFields];
  }

  return stickerPackRecord;
}

// callLinkDbRecord exposes additional fields not available on CallLinkType
export function toCallLinkRecord(
  callLinkDbRecord: CallLinkRecord
): Proto.CallLinkRecord {
  strictAssert(callLinkDbRecord.rootKey, 'toCallLinkRecord: no rootKey');

  const callLinkRecord = new Proto.CallLinkRecord();

  callLinkRecord.rootKey = callLinkDbRecord.rootKey;
  if (callLinkDbRecord.deleted === 1) {
    // adminKey is intentionally omitted for deleted call links.
    callLinkRecord.deletedAtTimestampMs = Long.fromNumber(
      callLinkDbRecord.deletedAt || new Date().getTime()
    );
  } else {
    strictAssert(
      callLinkDbRecord.adminKey,
      'toCallLinkRecord: no adminPasskey'
    );
    callLinkRecord.adminPasskey = callLinkDbRecord.adminKey;
  }

  if (callLinkDbRecord.storageUnknownFields) {
    callLinkRecord.$unknownFields = [callLinkDbRecord.storageUnknownFields];
  }

  return callLinkRecord;
}

export function toDefunctOrPendingCallLinkRecord(
  callLink: DefunctCallLinkType | PendingCallLinkType
): Proto.CallLinkRecord {
  const rootKey = toRootKeyBytes(callLink.rootKey);
  const adminKey = callLink.adminKey
    ? toAdminKeyBytes(callLink.adminKey)
    : null;

  strictAssert(rootKey, 'toDefunctOrPendingCallLinkRecord: no rootKey');
  strictAssert(adminKey, 'toDefunctOrPendingCallLinkRecord: no adminPasskey');

  const callLinkRecord = new Proto.CallLinkRecord();

  callLinkRecord.rootKey = rootKey;
  callLinkRecord.adminPasskey = adminKey;

  if (callLink.storageUnknownFields) {
    callLinkRecord.$unknownFields = [callLink.storageUnknownFields];
  }

  return callLinkRecord;
}

type MessageRequestCapableRecord = Proto.IContactRecord | Proto.IGroupV2Record;

function applyMessageRequestState(
  record: MessageRequestCapableRecord,
  conversation: ConversationModel
): void {
  const messageRequestEnum = Proto.SyncMessage.MessageRequestResponse.Type;

  if (record.blocked) {
    void conversation.applyMessageRequestResponse(messageRequestEnum.BLOCK, {
      source: MessageRequestResponseSource.STORAGE_SERVICE,
      learnedAtMs: Date.now(),
    });
  } else if (record.whitelisted) {
    // unblocking is also handled by this function which is why the next
    // condition is part of the else-if and not separate
    void conversation.applyMessageRequestResponse(messageRequestEnum.ACCEPT, {
      source: MessageRequestResponseSource.STORAGE_SERVICE,
      learnedAtMs: Date.now(),
    });
  } else if (!record.blocked) {
    // if the condition above failed the state could still be blocked=false
    // in which case we should unblock the conversation
    conversation.unblock({ viaStorageServiceSync: true });
  }

  if (record.whitelisted === false) {
    conversation.disableProfileSharing({
      reason: 'storage record not whitelisted',
      viaStorageServiceSync: true,
    });
  }
}

type RecordClassObject = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
};

function areNicknamesEqual(
  local: Proto.ContactRecord.IName | undefined | null,
  remote: Proto.ContactRecord.IName | undefined | null
): boolean {
  return local?.given === remote?.given && local?.family === remote?.family;
}

function logRecordChanges(
  localRecord: RecordClassObject | undefined,
  remoteRecord: RecordClassObject
): Array<string> {
  const details = new Array<string>();
  if (localRecord == null) {
    details.push('no local');
    return details;
  }

  for (const key of Object.keys(remoteRecord)) {
    const localValue = localRecord[key];
    const remoteValue = remoteRecord[key];

    // Sometimes we have a ByteBuffer and an Uint8Array, this ensures that we
    // are comparing them both equally by converting them into base64 string.
    if (localValue instanceof Uint8Array) {
      const areEqual = Bytes.areEqual(localValue, remoteValue);
      if (!areEqual) {
        details.push(`key=${key}: different bytes`);
      }
      continue;
    }

    // If both types are Long we can use Long's equals to compare them
    if (Long.isLong(localValue) || typeof localValue === 'number') {
      if (!Long.isLong(remoteValue) && typeof remoteValue !== 'number') {
        details.push(`key=${key}: type mismatch`);
        continue;
      }

      const areEqual = Long.fromValue(localValue).equals(
        Long.fromValue(remoteValue)
      );
      if (!areEqual) {
        details.push(`key=${key}: different integers`);
      }
      continue;
    }

    if (key === 'pinnedConversations') {
      const areEqual = arePinnedConversationsEqual(localValue, remoteValue);
      if (!areEqual) {
        details.push('pinnedConversations');
      }
      continue;
    }

    if (key === 'nickname') {
      const areEqual = areNicknamesEqual(localValue, remoteValue);
      if (!areEqual) {
        details.push('nickname');
      }
      continue;
    }

    if (localValue === remoteValue) {
      continue;
    }

    const isRemoteNullish =
      !remoteValue || (Long.isLong(remoteValue) && remoteValue.isZero());
    const isLocalNullish =
      !localValue || (Long.isLong(localValue) && localValue.isZero());

    // Sometimes we get `null` values from Protobuf and they should default to
    // false, empty string, or 0 for these records we do not count them as
    // conflicting.
    if (isRemoteNullish && isLocalNullish) {
      continue;
    }

    const areEqual = isEqual(localValue, remoteValue);

    if (!areEqual) {
      if (isRemoteNullish) {
        details.push(`key=${key}: removed`);
      } else if (isLocalNullish) {
        details.push(`key=${key}: added`);
      } else {
        details.push(`key=${key}: different values`);
      }
    }
  }
  return details;
}

export async function mergeGroupV1Record(
  storageID: string,
  storageVersion: number,
  groupV1Record: Proto.IGroupV1Record
): Promise<MergeResultType> {
  const redactedStorageID = redactExtendedStorageID({
    storageID,
    storageVersion,
  });
  if (!groupV1Record.id) {
    throw new Error(`No ID for ${redactedStorageID}`);
  }

  const groupId = Bytes.toBinary(groupV1Record.id);

  // Attempt to fetch an existing group pertaining to the `groupId` or create
  // a new group and populate it with the attributes from the record.
  let conversation = window.ConversationController.get(groupId);

  // Because ConversationController.get retrieves all types of records we
  // may sometimes have a situation where we get a record of groupv1 type
  // where the binary representation of its ID matches a v2 record in memory.
  // Here we ensure that the record we're about to process is GV1 otherwise
  // we drop the update.
  if (conversation && !isGroupV1(conversation.attributes)) {
    throw new Error(
      `Record has group type mismatch ${conversation.idForLogging()}`
    );
  }

  const details = logRecordChanges(
    conversation == null ? undefined : toGroupV1Record(conversation),
    groupV1Record
  );

  if (!conversation) {
    // It's possible this group was migrated to a GV2 if so we attempt to
    // retrieve the master key and find the conversation locally. If we
    // are successful then we continue setting and applying state.
    const masterKeyBuffer = deriveMasterKeyFromGroupV1(groupV1Record.id);
    const fields = deriveGroupFields(masterKeyBuffer);
    const derivedGroupV2Id = Bytes.toBase64(fields.id);

    details.push(
      'failed to find group by v1 id ' +
        `attempting lookup by v2 groupv2(${derivedGroupV2Id})`
    );
    conversation = window.ConversationController.get(derivedGroupV2Id);
  }
  if (!conversation) {
    if (groupV1Record.id.byteLength !== 16) {
      throw new Error('Not a valid gv1');
    }

    conversation = await window.ConversationController.getOrCreateAndWait(
      groupId,
      'group'
    );
    details.push('created a new group locally');
  }

  const oldStorageID = conversation.get('storageID');
  const oldStorageVersion = conversation.get('storageVersion');

  if (!isGroupV1(conversation.attributes)) {
    details.push('GV1 record for GV2 group, dropping');

    return {
      shouldDrop: true,
      conversation,
      oldStorageID,
      oldStorageVersion,
      details,
    };
  }

  conversation.set({
    storageID,
    storageVersion,
    needsStorageServiceSync: false,
  });

  if (isGroupV1(conversation.attributes)) {
    addUnknownFields(groupV1Record, conversation, details);
  } else {
    // We cannot preserve unknown fields if local group is V2 and the remote is
    // still V1, because the storageItem that we'll put into manifest will have
    // a different record type.

    // We want to upgrade group in the storage after merging it.
    conversation.set({ needsStorageServiceSync: true });
    details.push('marking v1 group for an update to v2');
  }

  return {
    conversation,
    oldStorageID,
    oldStorageVersion,
    details,
    updatedConversations: [conversation],
  };
}

function getGroupV2Conversation(
  masterKeyBuffer: Uint8Array
): ConversationModel {
  const groupFields = deriveGroupFields(masterKeyBuffer);

  const groupId = Bytes.toBase64(groupFields.id);
  const masterKey = Bytes.toBase64(masterKeyBuffer);
  const secretParams = Bytes.toBase64(groupFields.secretParams);
  const publicParams = Bytes.toBase64(groupFields.publicParams);

  // First we check for an existing GroupV2 group
  const groupV2 = window.ConversationController.get(groupId);
  if (groupV2) {
    groupV2.maybeRepairGroupV2({
      masterKey,
      secretParams,
      publicParams,
    });

    return groupV2;
  }

  // Then check for V1 group with matching derived GV2 id
  const groupV1 = window.ConversationController.getByDerivedGroupV2Id(groupId);
  if (groupV1) {
    return groupV1;
  }

  const conversationId = window.ConversationController.ensureGroup(groupId, {
    // Note: We don't set active_at, because we don't want the group to show until
    //   we have information about it beyond these initial details.
    //   see maybeUpdateGroup().
    groupVersion: 2,
    masterKey,
    secretParams,
    publicParams,
  });
  const conversation = window.ConversationController.get(conversationId);
  if (!conversation) {
    throw new Error(
      `getGroupV2Conversation: Failed to create conversation for groupv2(${groupId})`
    );
  }

  return conversation;
}

export async function mergeGroupV2Record(
  storageID: string,
  storageVersion: number,
  groupV2Record: Proto.IGroupV2Record
): Promise<MergeResultType> {
  const redactedStorageID = redactExtendedStorageID({
    storageID,
    storageVersion,
  });
  if (!groupV2Record.masterKey) {
    throw new Error(`No master key for ${redactedStorageID}`);
  }

  const masterKeyBuffer = groupV2Record.masterKey;
  const conversation = getGroupV2Conversation(masterKeyBuffer);

  const oldStorageID = conversation.get('storageID');
  const oldStorageVersion = conversation.get('storageVersion');

  const recordStorySendMode =
    groupV2Record.storySendMode ?? Proto.GroupV2Record.StorySendMode.DEFAULT;
  let storySendMode: StorySendMode;
  if (recordStorySendMode === Proto.GroupV2Record.StorySendMode.DEFAULT) {
    storySendMode = StorySendMode.IfActive;
  } else if (
    recordStorySendMode === Proto.GroupV2Record.StorySendMode.DISABLED
  ) {
    storySendMode = StorySendMode.Never;
  } else if (
    recordStorySendMode === Proto.GroupV2Record.StorySendMode.ENABLED
  ) {
    storySendMode = StorySendMode.Always;
  } else {
    throw missingCaseError(recordStorySendMode);
  }

  const details = logRecordChanges(
    toGroupV2Record(conversation),
    groupV2Record
  );

  conversation.set({
    hideStory: Boolean(groupV2Record.hideStory),
    isArchived: Boolean(groupV2Record.archived),
    markedUnread: Boolean(groupV2Record.markedUnread),
    dontNotifyForMentionsIfMuted: Boolean(
      groupV2Record.dontNotifyForMentionsIfMuted
    ),
    storageID,
    storageVersion,
    storySendMode,
    needsStorageServiceSync: false,
  });

  conversation.setMuteExpiration(
    getTimestampFromLong(
      groupV2Record.mutedUntilTimestamp,
      Number.MAX_SAFE_INTEGER
    ),
    {
      viaStorageServiceSync: true,
    }
  );

  applyMessageRequestState(groupV2Record, conversation);

  applyAvatarColor(conversation, groupV2Record.avatarColor);

  addUnknownFields(groupV2Record, conversation, details);

  if (isGroupV1(conversation.attributes)) {
    // If we found a GroupV1 conversation from this incoming GroupV2 record, we need to
    //   migrate it!

    // We don't await this because this could take a very long time, waiting for queues to
    //   empty, etc.
    drop(
      waitThenRespondToGroupV2Migration({
        conversation,
      })
    );
  } else {
    const isFirstSync = !window.storage.get('storageFetchComplete');
    const dropInitialJoinMessage = isFirstSync;

    // We don't await this because this could take a very long time, waiting for queues to
    //   empty, etc.
    drop(
      waitThenMaybeUpdateGroup(
        {
          conversation,
          dropInitialJoinMessage,
        },
        { viaFirstStorageSync: isFirstSync }
      )
    );
  }

  return {
    conversation,
    updatedConversations: [conversation],
    oldStorageID,
    oldStorageVersion,
    details,
  };
}

export async function mergeContactRecord(
  storageID: string,
  storageVersion: number,
  originalContactRecord: Proto.IContactRecord
): Promise<MergeResultType> {
  const contactRecord = {
    ...originalContactRecord,

    aci: fromAciUuidBytesOrString(
      originalContactRecord.aciBinary,
      originalContactRecord.aci,
      'ContactRecord.aci'
    ),
    pni: fromPniUuidBytesOrUntaggedString(
      originalContactRecord.pniBinary,
      originalContactRecord.pni,
      'ContactRecord.pni'
    ),
  };

  const e164 = dropNull(contactRecord.e164);
  const { aci } = contactRecord;
  const pni = dropNull(contactRecord.pni);
  const pniSignatureVerified = contactRecord.pniSignatureVerified || false;
  const serviceId = aci || pni;

  // All contacts must have UUID
  if (!serviceId) {
    return { shouldDrop: true, details: ['no uuid'] };
  }

  // Contacts should not have PNI as ACI
  if (aci && !isAciString(aci)) {
    return { shouldDrop: true, details: ['invalid aci'] };
  }

  if (
    window.storage.user.getOurServiceIdKind(serviceId) !== ServiceIdKind.Unknown
  ) {
    return { shouldDrop: true, details: ['our own uuid'] };
  }

  const { conversation } = window.ConversationController.maybeMergeContacts({
    aci,
    e164,
    pni,
    fromPniSignature: pniSignatureVerified,
    reason: 'mergeContactRecord',
  });

  const details = logRecordChanges(
    await toContactRecord(conversation),
    originalContactRecord
  );

  // We're going to ignore this; it's likely a PNI-only contact we've already merged
  if (conversation.getServiceId() !== serviceId) {
    const previousStorageID = conversation.get('storageID');
    const redactedpreviousStorageID = previousStorageID
      ? redactExtendedStorageID({
          storageID: previousStorageID,
          storageVersion: conversation.get('storageVersion'),
        })
      : '<none>';
    log.warn(
      `mergeContactRecord: ${conversation.idForLogging()} ` +
        `with storageId ${redactedpreviousStorageID} ` +
        `had serviceId that didn't match provided serviceId ${serviceId}`
    );
    return {
      shouldDrop: true,
      details,
    };
  }

  await conversation.updateUsername(dropNull(contactRecord.username), {
    shouldSave: false,
  });

  let needsProfileFetch = false;
  if (contactRecord.profileKey && contactRecord.profileKey.length > 0) {
    needsProfileFetch = await conversation.setProfileKey(
      Bytes.toBase64(contactRecord.profileKey),
      { viaStorageServiceSync: true, reason: 'mergeContactRecord' }
    );
  }

  const remoteName = dropNull(contactRecord.givenName);
  const remoteFamilyName = dropNull(contactRecord.familyName);
  const localName = conversation.get('profileName');
  const localFamilyName = conversation.get('profileFamilyName');
  if (
    remoteName &&
    (localName !== remoteName || localFamilyName !== remoteFamilyName)
  ) {
    log.info(
      `mergeContactRecord: ${conversation.idForLogging()} name doesn't match remote name; overwriting`
    );
    details.push('updated profile name');
    conversation.set({
      profileName: remoteName,
      profileFamilyName: remoteFamilyName,
    });
    if (localName) {
      log.info(
        `mergeContactRecord: ${conversation.idForLogging()} name doesn't match remote name; also fetching profile`
      );
      drop(conversation.getProfiles());
      details.push('refreshing profile');
    }
  }
  conversation.set({
    systemGivenName: dropNull(contactRecord.systemGivenName),
    systemFamilyName: dropNull(contactRecord.systemFamilyName),
    systemNickname: dropNull(contactRecord.systemNickname),
    nicknameGivenName: dropNull(contactRecord.nickname?.given),
    nicknameFamilyName: dropNull(contactRecord.nickname?.family),
    note: dropNull(contactRecord.note),
  });

  // https://github.com/signalapp/Signal-Android/blob/fc3db538bcaa38dc149712a483d3032c9c1f3998/app/src/main/java/org/thoughtcrime/securesms/database/RecipientDatabase.kt#L921-L936
  if (contactRecord.identityKey) {
    const verified = await conversation.safeGetVerified();
    let { identityState } = contactRecord;
    if (identityState == null) {
      identityState = Proto.ContactRecord.IdentityState.DEFAULT;
    }
    const newVerified = fromRecordVerified(identityState);

    const needsNotification =
      await window.textsecure.storage.protocol.updateIdentityAfterSync(
        serviceId,
        newVerified,
        contactRecord.identityKey
      );

    if (verified !== newVerified) {
      details.push(
        `updating verified state from=${verified} ` +
          `is_null=${identityState == null} to=${newVerified}`
      );

      conversation.set({ verified: newVerified });
    }

    const VERIFIED_ENUM = window.textsecure.storage.protocol.VerifiedStatus;
    if (needsNotification) {
      details.push('adding a verified notification');
      await conversation.addVerifiedChange(
        conversation.id,
        newVerified === VERIFIED_ENUM.VERIFIED,
        { local: false }
      );
    }
  }

  applyMessageRequestState(contactRecord, conversation);

  addUnknownFields(contactRecord, conversation, details);

  const oldStorageID = conversation.get('storageID');
  const oldStorageVersion = conversation.get('storageVersion');

  conversation.set({
    hideStory: Boolean(contactRecord.hideStory),
    isArchived: Boolean(contactRecord.archived),
    markedUnread: Boolean(contactRecord.markedUnread),
    storageID,
    storageVersion,
    needsStorageServiceSync: false,
  });

  if (contactRecord.hidden) {
    await conversation.removeContact({
      viaStorageServiceSync: true,
      shouldSave: false,
    });
  } else {
    await conversation.restoreContact({
      viaStorageServiceSync: true,
      shouldSave: false,
    });
  }

  conversation.setMuteExpiration(
    getTimestampFromLong(
      contactRecord.mutedUntilTimestamp,
      Number.MAX_SAFE_INTEGER
    ),
    {
      viaStorageServiceSync: true,
    }
  );

  if (
    !contactRecord.unregisteredAtTimestamp ||
    contactRecord.unregisteredAtTimestamp.equals(0)
  ) {
    conversation.setRegistered({ fromStorageService: true, shouldSave: false });
  } else {
    conversation.setUnregistered({
      timestamp: getTimestampFromLong(contactRecord.unregisteredAtTimestamp),
      fromStorageService: true,
      shouldSave: false,
    });
  }

  applyAvatarColor(conversation, contactRecord.avatarColor);

  return {
    conversation,
    updatedConversations: [conversation],
    needsProfileFetch,
    oldStorageID,
    oldStorageVersion,
    details,
  };
}

export async function mergeAccountRecord(
  storageID: string,
  storageVersion: number,
  accountRecord: Proto.IAccountRecord
): Promise<MergeResultType> {
  const {
    linkPreviews,
    unlistedPhoneNumber,
    noteToSelfArchived,
    noteToSelfMarkedUnread,
    phoneNumberSharingMode,
    pinnedConversations,
    profileKey,
    readReceipts,
    sealedSenderIndicators,
    typingIndicators,
    preferContactAvatars,
    universalExpireTimer,
    preferredReactionEmoji: rawPreferredReactionEmoji,
    donorSubscriberId,
    donorSubscriberCurrencyCode,
    donorSubscriptionManuallyCancelled,
    backupSubscriberData,
    backupTier,
    displayBadgesOnProfile,
    keepMutedChatsArchived,
    hasCompletedUsernameOnboarding,
    hasSeenGroupStoryEducationSheet,
    hasSetMyStoriesPrivacy,
    hasViewedOnboardingStory,
    storiesDisabled,
    storyViewReceiptsEnabled,
    username,
    usernameLink,
  } = accountRecord;

  const conversation =
    window.ConversationController.getOurConversationOrThrow();

  const details = logRecordChanges(
    toAccountRecord(conversation),
    accountRecord
  );

  const updatedConversations = new Array<ConversationModel>();

  await window.storage.put('read-receipt-setting', Boolean(readReceipts));

  if (typeof sealedSenderIndicators === 'boolean') {
    await window.storage.put('sealedSenderIndicators', sealedSenderIndicators);
  }

  if (typeof typingIndicators === 'boolean') {
    await window.storage.put('typingIndicators', typingIndicators);
  }

  if (typeof linkPreviews === 'boolean') {
    await window.storage.put('linkPreviews', linkPreviews);
  }

  if (typeof preferContactAvatars === 'boolean') {
    const previous = window.storage.get('preferContactAvatars');
    await window.storage.put('preferContactAvatars', preferContactAvatars);

    if (Boolean(previous) !== Boolean(preferContactAvatars)) {
      await window.ConversationController.forceRerender();
    }
  }

  if (preferredReactionEmoji.canBeSynced(rawPreferredReactionEmoji)) {
    const localPreferredReactionEmoji =
      window.storage.get('preferredReactionEmoji') || [];
    if (!isEqual(localPreferredReactionEmoji, rawPreferredReactionEmoji)) {
      log.warn(
        'storageService: remote and local preferredReactionEmoji do not match',
        localPreferredReactionEmoji.length,
        rawPreferredReactionEmoji.length
      );
    }
    await window.storage.put(
      'preferredReactionEmoji',
      rawPreferredReactionEmoji
    );
  }

  void setUniversalExpireTimer(
    DurationInSeconds.fromSeconds(universalExpireTimer || 0)
  );

  const PHONE_NUMBER_SHARING_MODE_ENUM =
    Proto.AccountRecord.PhoneNumberSharingMode;
  let phoneNumberSharingModeToStore: PhoneNumberSharingMode;
  switch (phoneNumberSharingMode) {
    case undefined:
    case null:
    case PHONE_NUMBER_SHARING_MODE_ENUM.EVERYBODY:
      phoneNumberSharingModeToStore = PhoneNumberSharingMode.Everybody;
      break;
    case PHONE_NUMBER_SHARING_MODE_ENUM.UNKNOWN:
    case PHONE_NUMBER_SHARING_MODE_ENUM.NOBODY:
      phoneNumberSharingModeToStore = PhoneNumberSharingMode.Nobody;
      break;
    default:
      assertDev(
        false,
        `storageService.mergeAccountRecord: Got an unexpected phone number sharing mode: ${phoneNumberSharingMode}. Falling back to default`
      );
      phoneNumberSharingModeToStore = PhoneNumberSharingMode.Everybody;
      break;
  }
  await window.storage.put(
    'phoneNumberSharingMode',
    phoneNumberSharingModeToStore
  );

  const discoverability = unlistedPhoneNumber
    ? PhoneNumberDiscoverability.NotDiscoverable
    : PhoneNumberDiscoverability.Discoverable;
  await window.storage.put('phoneNumberDiscoverability', discoverability);

  if (profileKey && profileKey.byteLength > 0) {
    void ourProfileKeyService.set(profileKey);
  }

  if (pinnedConversations) {
    const modelPinnedConversations = window
      .getConversations()
      .filter(convo => Boolean(convo.get('isPinned')));

    const modelPinnedConversationIds = modelPinnedConversations.map(convo =>
      convo.get('id')
    );

    const missingStoragePinnedConversationIds = window.storage
      .get('pinnedConversationIds', new Array<string>())
      .filter(id => !modelPinnedConversationIds.includes(id));

    if (missingStoragePinnedConversationIds.length !== 0) {
      log.warn(
        'mergeAccountRecord: pinnedConversationIds in storage does not match pinned Conversation models'
      );
    }

    const locallyPinnedConversations = modelPinnedConversations.concat(
      missingStoragePinnedConversationIds
        .map(conversationId =>
          window.ConversationController.get(conversationId)
        )
        .filter((convo): convo is ConversationModel => convo !== undefined)
    );

    details.push(
      `local pinned=${locallyPinnedConversations.length}`,
      `remote pinned=${pinnedConversations.length}`
    );

    const remotelyPinnedConversations = pinnedConversations
      .map(({ contact, legacyGroupId, groupMasterKey }) => {
        let convo: ConversationModel | undefined;

        if (contact) {
          if (
            !contact.serviceId &&
            !Bytes.isNotEmpty(contact.serviceIdBinary) &&
            !contact.e164
          ) {
            log.error(
              'storageService.mergeAccountRecord: No serviceId or e164 on contact'
            );
            return undefined;
          }
          convo = window.ConversationController.lookupOrCreate({
            serviceId: fromServiceIdBinaryOrString(
              contact.serviceIdBinary,
              contact.serviceId,
              'AccountRecord.pin.serviceId'
            ),
            e164: contact.e164,
            reason: 'storageService.mergeAccountRecord',
          });
        } else if (legacyGroupId && legacyGroupId.length) {
          const groupId = Bytes.toBinary(legacyGroupId);
          convo = window.ConversationController.get(groupId);
        } else if (groupMasterKey && groupMasterKey.length) {
          const groupFields = deriveGroupFields(groupMasterKey);
          const groupId = Bytes.toBase64(groupFields.id);

          convo = window.ConversationController.get(groupId);
        } else {
          log.error(
            'storageService.mergeAccountRecord: Invalid identifier received'
          );
        }

        if (!convo) {
          log.error(
            'storageService.mergeAccountRecord: missing conversation id.'
          );
          return undefined;
        }

        return convo;
      })
      .filter(isNotNil);

    const remotelyPinnedConversationIds = remotelyPinnedConversations.map(
      ({ id }) => id
    );

    const conversationsToUnpin = locallyPinnedConversations.filter(
      ({ id }) => !remotelyPinnedConversationIds.includes(id)
    );

    details.push(
      `unpinning=${conversationsToUnpin.length}`,
      `pinning=${remotelyPinnedConversations.length}`
    );

    conversationsToUnpin.forEach(convo => {
      convo.set({ isPinned: false });
      updatedConversations.push(convo);
    });

    remotelyPinnedConversations.forEach(convo => {
      convo.set({ isPinned: true, isArchived: false });
      updatedConversations.push(convo);
    });

    await window.storage.put(
      'pinnedConversationIds',
      remotelyPinnedConversationIds
    );
  }

  if (Bytes.isNotEmpty(donorSubscriberId)) {
    await window.storage.put('subscriberId', donorSubscriberId);
  }
  if (typeof donorSubscriberCurrencyCode === 'string') {
    await window.storage.put(
      'subscriberCurrencyCode',
      donorSubscriberCurrencyCode
    );
  }
  if (donorSubscriptionManuallyCancelled != null) {
    await window.storage.put(
      'donorSubscriptionManuallyCancelled',
      donorSubscriptionManuallyCancelled
    );
  }

  await saveBackupsSubscriberData(backupSubscriberData);
  await saveBackupTier(backupTier?.toNumber());

  await window.storage.put(
    'displayBadgesOnProfile',
    Boolean(displayBadgesOnProfile)
  );
  await window.storage.put(
    'keepMutedChatsArchived',
    Boolean(keepMutedChatsArchived)
  );
  await window.storage.put(
    'hasSetMyStoriesPrivacy',
    Boolean(hasSetMyStoriesPrivacy)
  );
  {
    const hasViewedOnboardingStoryBool = Boolean(hasViewedOnboardingStory);
    await window.storage.put(
      'hasViewedOnboardingStory',
      hasViewedOnboardingStoryBool
    );
    if (hasViewedOnboardingStoryBool) {
      drop(findAndDeleteOnboardingStoryIfExists());
    } else {
      drop(downloadOnboardingStory());
    }
  }
  {
    const hasCompletedUsernameOnboardingBool = Boolean(
      hasCompletedUsernameOnboarding
    );
    await window.storage.put(
      'hasCompletedUsernameOnboarding',
      hasCompletedUsernameOnboardingBool
    );
  }
  {
    const hasCompletedUsernameOnboardingBool = Boolean(
      hasSeenGroupStoryEducationSheet
    );
    await window.storage.put(
      'hasSeenGroupStoryEducationSheet',
      hasCompletedUsernameOnboardingBool
    );
  }
  {
    const hasStoriesDisabled = Boolean(storiesDisabled);
    await window.storage.put('hasStoriesDisabled', hasStoriesDisabled);
    window.textsecure.server?.onHasStoriesDisabledChange(hasStoriesDisabled);
  }

  switch (storyViewReceiptsEnabled) {
    case Proto.OptionalBool.ENABLED:
      await window.storage.put('storyViewReceiptsEnabled', true);
      break;
    case Proto.OptionalBool.DISABLED:
      await window.storage.put('storyViewReceiptsEnabled', false);
      break;
    case Proto.OptionalBool.UNSET:
    default:
      // Do nothing
      break;
  }

  if (usernameLink?.entropy?.length && usernameLink?.serverId?.length) {
    const oldLink = window.storage.get('usernameLink');
    if (
      window.storage.get('usernameLinkCorrupted') &&
      (!oldLink ||
        !Bytes.areEqual(usernameLink.entropy, oldLink.entropy) ||
        !Bytes.areEqual(usernameLink.serverId, oldLink.serverId))
    ) {
      details.push('clearing username link corruption');
      await window.storage.remove('usernameLinkCorrupted');
    }

    await Promise.all([
      usernameLink.color &&
        window.storage.put('usernameLinkColor', usernameLink.color),
      window.storage.put('usernameLink', {
        entropy: usernameLink.entropy,
        serverId: usernameLink.serverId,
      }),
    ]);
  } else {
    await Promise.all([
      window.storage.remove('usernameLinkColor'),
      window.storage.remove('usernameLink'),
    ]);
  }

  addUnknownFields(accountRecord, conversation, details);

  const oldStorageID = conversation.get('storageID');
  const oldStorageVersion = conversation.get('storageVersion');

  if (
    window.storage.get('usernameCorrupted') &&
    username !== conversation.get('username')
  ) {
    details.push('clearing username corruption');
    await window.storage.remove('usernameCorrupted');
  }

  conversation.set({
    isArchived: Boolean(noteToSelfArchived),
    markedUnread: Boolean(noteToSelfMarkedUnread),
    username: dropNull(username),
    storageID,
    storageVersion,
    needsStorageServiceSync: false,
  });

  let needsProfileFetch = false;
  if (profileKey && profileKey.byteLength > 0) {
    needsProfileFetch = await conversation.setProfileKey(
      Bytes.toBase64(profileKey),
      { viaStorageServiceSync: true, reason: 'mergeAccountRecord' }
    );

    const avatarUrl = dropNull(accountRecord.avatarUrlPath);
    await conversation.setAndMaybeFetchProfileAvatar({
      avatarUrl,
      decryptionKey: profileKey,
    });
    await window.storage.put('avatarUrl', avatarUrl);
  }

  applyAvatarColor(conversation, accountRecord.avatarColor);

  updatedConversations.push(conversation);

  return {
    conversation,
    updatedConversations,
    needsProfileFetch,
    oldStorageID,
    oldStorageVersion,
    details,
  };
}

export async function mergeStoryDistributionListRecord(
  storageID: string,
  storageVersion: number,
  storyDistributionListRecord: Proto.IStoryDistributionListRecord
): Promise<MergeResultType> {
  const redactedStorageID = redactExtendedStorageID({
    storageID,
    storageVersion,
  });
  if (!storyDistributionListRecord.identifier) {
    throw new Error(
      `No storyDistributionList identifier for ${redactedStorageID}`
    );
  }

  const isMyStory = Bytes.areEqual(
    MY_STORY_BYTES,
    storyDistributionListRecord.identifier
  );

  let listId: StoryDistributionIdString;
  if (isMyStory) {
    listId = MY_STORY_ID;
  } else {
    const uuid = bytesToUuid(storyDistributionListRecord.identifier);
    strictAssert(uuid, 'mergeStoryDistributionListRecord: no distribution id');
    listId = normalizeStoryDistributionId(
      uuid,
      'mergeStoryDistributionListRecord'
    );
  }

  const localStoryDistributionList =
    await DataReader.getStoryDistributionWithMembers(listId);

  const details = logRecordChanges(
    localStoryDistributionList == null
      ? undefined
      : toStoryDistributionListRecord(localStoryDistributionList),
    storyDistributionListRecord
  );

  let remoteListMembers: Array<ServiceIdString>;

  if (storyDistributionListRecord.recipientServiceIdsBinary?.length) {
    remoteListMembers =
      storyDistributionListRecord.recipientServiceIdsBinary.map(id =>
        fromServiceIdBinaryOrString(id, undefined, 'unused')
      );
  } else if (storyDistributionListRecord.recipientServiceIds?.length) {
    remoteListMembers = storyDistributionListRecord.recipientServiceIds.map(
      id => normalizeServiceId(id, 'mergeStoryDistributionListRecord')
    );
  } else {
    remoteListMembers = [];
  }

  if (storyDistributionListRecord.$unknownFields) {
    details.push('adding unknown fields');
  }

  const deletedAtTimestamp = getTimestampFromLong(
    storyDistributionListRecord.deletedAtTimestamp
  );

  const storyDistribution: StoryDistributionWithMembersType = {
    id: listId,
    name: String(storyDistributionListRecord.name),
    deletedAtTimestamp: isMyStory ? undefined : deletedAtTimestamp,
    allowsReplies: Boolean(storyDistributionListRecord.allowsReplies),
    isBlockList: Boolean(storyDistributionListRecord.isBlockList),
    members: remoteListMembers,
    senderKeyInfo: localStoryDistributionList?.senderKeyInfo,

    storageID,
    storageVersion,
    storageUnknownFields: storyDistributionListRecord.$unknownFields
      ? Bytes.concatenate(storyDistributionListRecord.$unknownFields)
      : null,
    storageNeedsSync: false,
  };

  if (!localStoryDistributionList) {
    await DataWriter.createNewStoryDistribution(storyDistribution);

    const shouldSave = false;
    window.reduxActions.storyDistributionLists.createDistributionList(
      storyDistribution.name,
      remoteListMembers,
      storyDistribution,
      shouldSave
    );

    return {
      details,
    };
  }

  const oldStorageID = localStoryDistributionList.storageID;
  const oldStorageVersion = localStoryDistributionList.storageVersion;

  const needsToClearUnknownFields =
    !storyDistributionListRecord.$unknownFields &&
    localStoryDistributionList.storageUnknownFields;

  if (needsToClearUnknownFields) {
    details.push('clearing unknown fields');
  }

  const isBadRemoteData = !deletedAtTimestamp && !storyDistribution.name;
  if (isBadRemoteData) {
    Object.assign(storyDistribution, {
      name: localStoryDistributionList.name,
      members: localStoryDistributionList.members,
    });
  }

  const localMembersListSet = new Set(localStoryDistributionList.members);
  const toAdd: Array<ServiceIdString> = remoteListMembers.filter(
    serviceId => !localMembersListSet.has(serviceId)
  );

  const remoteMemberListSet = new Set(remoteListMembers);
  const toRemove: Array<ServiceIdString> =
    localStoryDistributionList.members.filter(
      serviceId => !remoteMemberListSet.has(serviceId)
    );

  details.push('updated');
  await DataWriter.modifyStoryDistributionWithMembers(storyDistribution, {
    toAdd,
    toRemove,
  });
  window.reduxActions.storyDistributionLists.modifyDistributionList({
    allowsReplies: Boolean(storyDistribution.allowsReplies),
    deletedAtTimestamp: storyDistribution.deletedAtTimestamp,
    id: storyDistribution.id,
    isBlockList: Boolean(storyDistribution.isBlockList),
    membersToAdd: toAdd,
    membersToRemove: toRemove,
    name: storyDistribution.name,
  });

  return {
    details,
    oldStorageID,
    oldStorageVersion,
  };
}

export async function mergeStickerPackRecord(
  storageID: string,
  storageVersion: number,
  stickerPackRecord: Proto.IStickerPackRecord
): Promise<MergeResultType> {
  const redactedStorageID = redactExtendedStorageID({
    storageID,
    storageVersion,
  });
  if (!stickerPackRecord.packId || Bytes.isEmpty(stickerPackRecord.packId)) {
    throw new Error(`No stickerPackRecord identifier for ${redactedStorageID}`);
  }

  const id = Bytes.toHex(stickerPackRecord.packId);

  const localStickerPack = await DataReader.getStickerPackInfo(id);

  const details = logRecordChanges(
    localStickerPack == null
      ? undefined
      : toStickerPackRecord(localStickerPack),
    stickerPackRecord
  );

  if (stickerPackRecord.$unknownFields) {
    details.push('adding unknown fields');
  }
  const storageUnknownFields = stickerPackRecord.$unknownFields
    ? Bytes.concatenate(stickerPackRecord.$unknownFields)
    : null;

  let stickerPack: StickerPackInfoType;
  if (stickerPackRecord.deletedAtTimestamp?.toNumber()) {
    stickerPack = {
      id,
      uninstalledAt: stickerPackRecord.deletedAtTimestamp.toNumber(),
      storageID,
      storageVersion,
      storageUnknownFields,
      storageNeedsSync: false,
    };
  } else {
    if (
      !stickerPackRecord.packKey ||
      Bytes.isEmpty(stickerPackRecord.packKey)
    ) {
      throw new Error(`No stickerPackRecord key for ${redactedStorageID}`);
    }

    stickerPack = {
      id,
      key: Bytes.toBase64(stickerPackRecord.packKey),
      position:
        'position' in stickerPackRecord
          ? stickerPackRecord.position
          : (localStickerPack?.position ?? undefined),
      storageID,
      storageVersion,
      storageUnknownFields,
      storageNeedsSync: false,
    };
  }

  const oldStorageID = localStickerPack?.storageID;
  const oldStorageVersion = localStickerPack?.storageVersion;

  const needsToClearUnknownFields =
    !stickerPack.storageUnknownFields && localStickerPack?.storageUnknownFields;

  if (needsToClearUnknownFields) {
    details.push('clearing unknown fields');
  }

  const wasUninstalled = Boolean(localStickerPack?.uninstalledAt);
  const isUninstalled = Boolean(stickerPack.uninstalledAt);

  details.push(
    `wasUninstalled=${wasUninstalled}`,
    `isUninstalled=${isUninstalled}`,
    `oldPosition=${localStickerPack?.position ?? '?'}`,
    `newPosition=${stickerPack.position ?? '?'}`
  );

  if (!wasUninstalled && isUninstalled) {
    if (localStickerPack != null) {
      assertDev(localStickerPack.key, 'Installed sticker pack has no key');
      window.reduxActions.stickers.uninstallStickerPack(
        localStickerPack.id,
        localStickerPack.key,
        {
          actionSource: 'storageService',
          uninstalledAt: stickerPack.uninstalledAt,
        }
      );
    } else {
      strictAssert(
        stickerPack.key == null && stickerPack.uninstalledAt != null,
        'Created sticker pack must be already uninstalled'
      );
      await DataWriter.addUninstalledStickerPack(stickerPack);
    }
  } else if ((!localStickerPack || wasUninstalled) && !isUninstalled) {
    assertDev(stickerPack.key, 'Sticker pack does not have key');

    const status = Stickers.getStickerPackStatus(stickerPack.id);
    if (status === 'downloaded') {
      window.reduxActions.stickers.installStickerPack(
        stickerPack.id,
        stickerPack.key,
        {
          actionSource: 'storageService',
        }
      );
    } else {
      void Stickers.downloadStickerPack(stickerPack.id, stickerPack.key, {
        finalStatus: 'installed',
        actionSource: 'storageService',
      });
    }
  }

  await DataWriter.updateStickerPackInfo(stickerPack);

  return {
    details,
    oldStorageID,
    oldStorageVersion,
  };
}

export async function mergeCallLinkRecord(
  storageID: string,
  storageVersion: number,
  callLinkRecord: Proto.ICallLinkRecord
): Promise<MergeResultType> {
  const redactedStorageID = redactExtendedStorageID({
    storageID,
    storageVersion,
  });
  // callLinkRecords must have rootKey
  if (!callLinkRecord.rootKey) {
    return { shouldDrop: true, details: ['no rootKey'] };
  }

  const rootKeyString = fromRootKeyBytes(callLinkRecord.rootKey);
  const adminKeyString = callLinkRecord.adminPasskey
    ? fromAdminKeyBytes(callLinkRecord.adminPasskey)
    : null;

  const roomId = getRoomIdFromRootKeyString(rootKeyString);
  const logId = `mergeCallLinkRecord(${redactedStorageID}, ${roomId})`;

  const localCallLinkDbRecord =
    await DataReader.getCallLinkRecordByRoomId(roomId);

  const details = logRecordChanges(
    localCallLinkDbRecord == null
      ? undefined
      : toCallLinkRecord(localCallLinkDbRecord),
    callLinkRecord
  );

  // Note deletedAtTimestampMs can be 0
  const deletedAtTimestampMs = callLinkRecord.deletedAtTimestampMs?.toNumber();
  const deletedAt = deletedAtTimestampMs || null;
  const shouldDrop = Boolean(
    deletedAt && isOlderThan(deletedAt, getMessageQueueTime())
  );
  if (shouldDrop) {
    details.push(
      `expired deleted call link deletedAt=${deletedAt}; scheduling for removal`
    );
  }

  const callLinkDbRecord: CallLinkRecord = {
    roomId,
    rootKey: callLinkRecord.rootKey,
    adminKey: callLinkRecord.adminPasskey ?? null,
    name: localCallLinkDbRecord?.name ?? '',
    restrictions: localCallLinkDbRecord?.restrictions ?? 0,
    expiration: localCallLinkDbRecord?.expiration ?? null,
    revoked: localCallLinkDbRecord?.revoked === 1 ? 1 : 0,
    deleted: deletedAt ? 1 : 0,
    deletedAt,

    storageID,
    storageVersion,
    storageUnknownFields: callLinkRecord.$unknownFields
      ? Bytes.concatenate(callLinkRecord.$unknownFields)
      : null,
    storageNeedsSync: 0,
  };

  if (!localCallLinkDbRecord) {
    if (deletedAt) {
      details.push(
        `skipping deleted call link with no matching local record deletedAt=${deletedAt}`
      );
    } else if (await DataReader.defunctCallLinkExists(roomId)) {
      details.push('skipping known defunct call link');
    } else if (callLinkRefreshJobQueue.hasPendingCallLink(storageID)) {
      details.push('pending call link refresh, updating storage fields');
      callLinkRefreshJobQueue.updatePendingCallLinkStorageFields(
        rootKeyString,
        {
          storageID,
          storageVersion,
          storageUnknownFields: callLinkDbRecord.storageUnknownFields,
          storageNeedsSync: false,
        }
      );
    } else {
      details.push('new call link, enqueueing call link refresh and create');

      // Queue a job to refresh the call link to confirm its existence.
      // Include the bundle of call link data so we can insert the call link
      // after confirmation.
      const callLink = callLinkFromRecord(callLinkDbRecord);
      drop(
        callLinkRefreshJobQueue.add({
          rootKey: callLink.rootKey,
          adminKey: callLink.adminKey,
          storageID: callLink.storageID,
          storageVersion: callLink.storageVersion,
          storageUnknownFields: callLink.storageUnknownFields,
          source: `storage.mergeCallLinkRecord(${redactedStorageID})`,
        })
      );
    }

    return {
      details,
      shouldDrop,
    };
  }

  const oldStorageID = localCallLinkDbRecord.storageID || undefined;
  const oldStorageVersion = localCallLinkDbRecord.storageVersion || undefined;

  const needsToClearUnknownFields =
    !callLinkRecord.$unknownFields &&
    localCallLinkDbRecord.storageUnknownFields;
  if (needsToClearUnknownFields) {
    details.push('clearing unknown fields');
  }

  const isBadRemoteData = Boolean(deletedAt && adminKeyString);
  if (isBadRemoteData) {
    log.warn(
      `${logId}: Found bad remote data: deletedAtTimestampMs and adminPasskey were both present. Assuming deleted.`
    );
  }

  // First update local record
  details.push('updated');
  const callLink = callLinkFromRecord(callLinkDbRecord);
  await DataWriter.updateCallLink(callLink);

  // Deleted in storage but we have it locally: Delete locally too and update redux
  if (deletedAt && localCallLinkDbRecord.deleted !== 1) {
    // Another device deleted the link and uploaded to storage, and we learned about it
    log.info(`${logId}: Discovered deleted call link, deleting locally`);
    details.push('deleting locally');
    // No need to delete via RingRTC as we assume the originating device did that already
    await DataWriter.deleteCallLinkAndHistory(roomId);
    window.reduxActions.calling.handleCallLinkDelete({ roomId });
  } else if (!deletedAt && localCallLinkDbRecord.deleted === 1) {
    // Not deleted in storage, but we've marked it as deleted locally.
    // Skip doing anything, we will update things locally after sync.
    log.warn(`${logId}: Found call link, but it was marked deleted locally.`);
  } else {
    window.reduxActions.calling.handleCallLinkUpdate({
      rootKey: rootKeyString,
      adminKey: adminKeyString,
    });
  }

  return {
    details,
    shouldDrop,
    oldStorageID,
    oldStorageVersion,
  };
}
