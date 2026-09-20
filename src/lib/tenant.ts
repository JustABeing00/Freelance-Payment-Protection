import { AppError } from "./errors.js";

/**
 * Tenant isolation (security-principles §1, §4).
 * Every row carries workspace_id; every handler scopes by it.
 * Enforcement order: authenticate → membership → scope → object check.
 */

export interface TenantResource {
  readonly workspaceId: string;
}

/** Throws FORBIDDEN on mismatch. Generic message avoids oracle leaks. */
export function assertSameWorkspace(
  actorWorkspaceId: string,
  resource: TenantResource | null | undefined,
): void {
  if (resource?.workspaceId !== actorWorkspaceId) {
    throw AppError.forbidden();
  }
}

/** Prisma-style scope fragment: spread into every where-clause. */
export function tenantScope(workspaceId: string): { workspaceId: string } {
  if (!workspaceId) throw AppError.forbidden();
  return { workspaceId };
}

/** Filter a list to one tenant (defense in depth behind scoped queries). */
export function filterByWorkspace<T extends TenantResource>(
  workspaceId: string,
  rows: readonly T[],
): T[] {
  return rows.filter((r) => r.workspaceId === workspaceId);
}
