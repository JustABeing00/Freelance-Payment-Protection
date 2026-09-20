import { AppError } from "./errors.js";

/**
 * Ownership-boundary authorization (session 03).
 *
 * Model: user → membership → workspace → {clients, projects}.
 * - A user may belong to many workspaces (solo, assistant, multiple brands).
 * - Every protected row carries workspaceId; every handler resolves the
 *   workspace from the URL, requires an active membership, then checks the
 *   row's workspaceId against the URL workspaceId (IDOR guard).
 * - Roles: owner (full) > member (write, no member mgmt) > accountant_readonly
 *   (read-only; cannot create/update anything).
 * - Failure messages are generic ("Access denied") so IDs cannot be probed.
 */

export type WorkspaceRole = "owner" | "member" | "accountant_readonly";

export interface MembershipLike {
  readonly userId: string;
  readonly workspaceId: string;
  readonly role: WorkspaceRole;
}

export interface WorkspaceScopedResource {
  readonly workspaceId: string;
}

const WRITE_ROLES: readonly WorkspaceRole[] = ["owner", "member"];

/** Throw FORBIDDEN unless the membership exists. Collapses not-found/not-member. */
export function requireMembership<T extends MembershipLike>(membership: T | null | undefined): T {
  if (!membership) throw AppError.forbidden();
  return membership;
}

/** Throw FORBIDDEN unless the membership role is in the allow-list. */
export function requireRole(membership: MembershipLike, allowed: readonly WorkspaceRole[]): void {
  if (!allowed.includes(membership.role)) throw AppError.forbidden();
}

/** Throw FORBIDDEN for read-only roles attempting a write. */
export function requireWriteAccess(membership: MembershipLike): void {
  requireRole(membership, WRITE_ROLES);
}

/** Owner-only gate (member management, destructive actions). */
export function requireOwner(membership: MembershipLike): void {
  requireRole(membership, ["owner"]);
}

/**
 * IDOR guard: the row's workspace must equal the workspace in the URL,
 * and the actor must be a member of that workspace. Both failures map to
 * generic FORBIDDEN so resource existence cannot be probed across tenants.
 */
export function assertResourceInWorkspace(
  urlWorkspaceId: string,
  membership: MembershipLike | null | undefined,
  resource: WorkspaceScopedResource | null | undefined,
): void {
  const member = requireMembership(membership);
  if (member.workspaceId !== urlWorkspaceId) throw AppError.forbidden();
  if (resource?.workspaceId !== urlWorkspaceId) throw AppError.forbidden();
}

/** Normalize emails for lookup/uniqueness (case-insensitive, trimmed). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
