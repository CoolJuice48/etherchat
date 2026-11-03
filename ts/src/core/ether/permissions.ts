// Write modes and the permission matrix (go/core/ether/permissions.go).

import { invalid } from '../errors.ts'
import { goQuote } from './gofmt.ts'
import { ZONE_SHARED, ZONE_WORKSPACE, type Zone } from './paths.ts'

/** A shared file's write mode. */
export type Mode = 'author_only' | 'shared_edit'

export const MODE_AUTHOR_ONLY: Mode = 'author_only'
export const MODE_SHARED_EDIT: Mode = 'shared_edit'

/** Validates a mode string. */
export function parseMode(s: string): Mode {
  if (s === MODE_AUTHOR_ONLY || s === MODE_SHARED_EDIT) return s
  throw invalid(`mode must be ${goQuote(MODE_AUTHOR_ONLY)} or ${goQuote(MODE_SHARED_EDIT)}`)
}

/** An action on a file or folder. The value is Go's Op.String(). */
export type Op = 'read' | 'create' | 'edit' | 'delete' | 'change mode'

export const OP_READ: Op = 'read'
export const OP_CREATE: Op = 'create'
export const OP_EDIT: Op = 'edit'
export const OP_DELETE: Op = 'delete'
export const OP_CHANGE_MODE: Op = 'change mode'

/**
 * A file or folder from the acting member's point of view. Membership is
 * checked before allowed is consulted: non-members get not_found and never
 * reach this.
 */
export interface Target {
  zone: Zone
  /** The workspace belongs to the actor (workspace zone). */
  ownWorkspace?: boolean
  /** The actor created the node (shared zone). */
  isAuthor?: boolean
  /** The actor owns the ether. */
  isOwner?: boolean
  /** The node's mode (shared zone, existing nodes); undefined for new ones. */
  mode?: Mode
}

/**
 * The permission matrix:
 *
 *                  own workspace  other workspace  shared author_only  shared shared_edit
 *  read            yes            yes              yes                 yes
 *  create          yes            no               yes                 n/a
 *  edit            yes            no               author              any member
 *  delete          yes            no               author              author or owner
 *  change mode     n/a            no               author              author or owner
 */
export function allowed(op: Op, t: Target): boolean {
  if (op === OP_READ) return true
  switch (t.zone) {
    case ZONE_WORKSPACE:
      return !!t.ownWorkspace && op !== OP_CHANGE_MODE
    case ZONE_SHARED:
      switch (op) {
        case OP_CREATE:
          return true
        case OP_EDIT:
          return !!t.isAuthor || t.mode === MODE_SHARED_EDIT
        case OP_DELETE:
        case OP_CHANGE_MODE:
          return !!t.isAuthor || (!!t.isOwner && t.mode === MODE_SHARED_EDIT)
      }
  }
  return false
}
