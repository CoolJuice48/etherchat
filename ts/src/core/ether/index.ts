// Etherchat's domain (a port of go/core/ether): EtherService and every type,
// constant and helper the other parts use. See service.ts for the methods.

export { EtherService } from './service.ts'

export {
  Ether,
  Member,
  INTENT_FYI,
  INTENT_HANDOFF,
  INTENT_PRIMER,
  INTENT_REVIEW,
  INTENT_UPDATE,
  parseIntent,
} from './model.ts'
export type {
  Account,
  Actor,
  ActivityFilter,
  AllowedEmail,
  AuditEntry,
  Change,
  Digest,
  EtherStats,
  Event,
  Fields,
  File,
  FileInfo,
  Intent,
  Invite,
  MemberActivity,
  Post,
  PostInput,
  RequestAnswer,
  RequestEmail,
  VersionInfo,
  WriteResult,
} from './model.ts'

export {
  MAX_OPEN_REQUESTS,
  Recipient,
  Request,
  REQUEST_ANSWERED,
  REQUEST_EMAIL_GAP_MS,
  REQUEST_EXPIRED,
  REQUEST_OPEN,
  REQUEST_TTL_MS,
  REQUEST_WITHDRAWN,
} from './requests.ts'
export type { AskInput, RequestStatus } from './requests.ts'

export {
  allowed,
  MODE_AUTHOR_ONLY,
  MODE_SHARED_EDIT,
  OP_CHANGE_MODE,
  OP_CREATE,
  OP_DELETE,
  OP_EDIT,
  OP_READ,
  parseMode,
} from './permissions.ts'
export type { Mode, Op, Target } from './permissions.ts'

export { Path, parsePath, ZONE_SHARED, ZONE_WORKSPACE } from './paths.ts'
export type { Zone } from './paths.ts'

export { MAX_AGENT_NAME, normalizeEmail, validHandle } from './names.ts'
