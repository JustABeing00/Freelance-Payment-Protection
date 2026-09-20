import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { PasswordHash } from "./auth.js";
import { normalizeEmail, type WorkspaceRole } from "./authz.js";
import { AppError } from "./errors.js";

/**
 * Persistence seam for identity + tenant resources.
 *
 * - `Store` is the interface every route programs against: ownership checks
 *   live in the routes/authz layer, never in raw Prisma calls, so IDOR guards
 *   cannot be bypassed by a new handler.
 * - `InMemoryStore` backs tests (no Postgres required) and local dev.
 * - `PrismaStore` backs production (Postgres). Prisma client is imported
 *   lazily so unit/integration tests never touch a live DB.
 */

export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: PasswordHash;
  readonly createdAt: Date;
  readonly lastLoginAt?: Date | undefined;
}

export interface WorkspaceRecord {
  readonly id: string;
  readonly name: string;
  readonly ownerUserId: string;
  readonly createdAt: Date;
  /** Raw workspace reminder defaults blob (`{}` = built-in default policy). */
  readonly reminderDefaults?: Record<string, unknown> | undefined;
}

export interface MembershipRecord {
  readonly userId: string;
  readonly workspaceId: string;
  readonly role: WorkspaceRole;
  readonly createdAt: Date;
}

export interface ClientRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly email: string;
  readonly company?: string | undefined;
  readonly phone?: string | undefined;
  readonly billingEmail?: string | undefined;
  readonly billingAddress?: string | undefined;
  readonly timezone?: string | undefined;
  readonly country?: string | undefined;
  readonly notes?: string | undefined;
  readonly status: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ProjectRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly clientId: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly currency: string;
  readonly totalValueCents: number;
  readonly startDate?: Date | undefined;
  readonly expectedCompletion?: Date | undefined;
  readonly paymentTerms?: string | undefined;
  readonly status: string;
  /** Per-project reminder-policy override (`{}` = inherit workspace defaults). */
  readonly reminderPolicy?: Record<string, unknown> | undefined;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface MilestoneRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly amountCents: number;
  readonly currency: string;
  readonly dueDate?: Date | undefined;
  readonly workState: string;
  readonly paymentState: string;
  readonly approvalState: string;
  readonly deliverableState: string;
  readonly unlockState: string;
  readonly appliedPaymentIds: readonly string[];
  readonly amountHistory: readonly Record<string, unknown>[];
  readonly approvedVersionId?: string | undefined;
  readonly currentVersionId?: string | undefined;
  readonly orderIndex: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateMilestoneInput {
  title: string;
  description?: string | undefined;
  amountCents: number;
  currency?: string | undefined;
  dueDate?: Date | undefined;
  orderIndex: number;
  workState?: string | undefined;
  paymentState?: string | undefined;
  approvalState?: string | undefined;
  deliverableState?: string | undefined;
  unlockState?: string | undefined;
  currentVersionId?: string | undefined;
}

export interface UpdateMilestoneInput {
  title?: string | undefined;
  description?: string | null | undefined;
  amountCents?: number | undefined;
  currency?: string | undefined;
  dueDate?: Date | null | undefined;
  orderIndex?: number | undefined;
  workState?: string | undefined;
  paymentState?: string | undefined;
  approvalState?: string | undefined;
  deliverableState?: string | undefined;
  unlockState?: string | undefined;
  appliedPaymentIds?: readonly string[] | undefined;
  amountHistory?: readonly Record<string, unknown>[] | undefined;
  approvedVersionId?: string | null | undefined;
  currentVersionId?: string | null | undefined;
}

export interface AppendProjectEventInput {
  milestoneId?: string | undefined;
  type: string;
  actorType: string;
  actorId?: string | undefined;
  occurredAt?: Date | undefined;
  payload?: Record<string, unknown> | undefined;
  idempotencyKey?: string | undefined;
}

export interface PaymentRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly milestoneId?: string | undefined;
  readonly provider: string;
  readonly providerPaymentId: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly state: string;
  readonly idempotencyKey: string;
  readonly rawWebhookRef?: string | undefined;
  readonly receivedAt?: Date | undefined;
  readonly createdAt: Date;
}

export interface CreatePaymentInput {
  id?: string | undefined;
  projectId: string;
  milestoneId?: string | undefined;
  provider?: string | undefined;
  providerPaymentId: string;
  amountCents: number;
  currency: string;
  state?: string | undefined;
  idempotencyKey: string;
  rawWebhookRef?: string | undefined;
  receivedAt?: Date | undefined;
}

export interface UpdatePaymentLifecycleInput {
  state?: string | undefined;
  rawWebhookRef?: string | undefined;
  receivedAt?: Date | undefined;
}

export interface ProjectEventRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly milestoneId?: string | undefined;
  readonly type: string;
  readonly actorType: string;
  readonly occurredAt: Date;
  readonly payload: Record<string, unknown>;
}

export interface CreateUserInput {
  email: string;
  displayName: string;
  passwordHash: PasswordHash;
}

export interface CreateWorkspaceInput {
  name: string;
}

export interface CreateClientInput {
  name: string;
  email: string;
  company?: string | undefined;
  phone?: string | undefined;
  billingEmail?: string | undefined;
  billingAddress?: string | undefined;
  timezone?: string | undefined;
  country?: string | undefined;
  notes?: string | undefined;
  status?: string | undefined;
}

export interface UpdateClientInput {
  name?: string | undefined;
  company?: string | null | undefined;
  phone?: string | null | undefined;
  billingEmail?: string | null | undefined;
  billingAddress?: string | null | undefined;
  timezone?: string | null | undefined;
  country?: string | null | undefined;
  notes?: string | null | undefined;
  status?: string | undefined;
}

export interface CreateProjectInput {
  clientId: string;
  title: string;
  description?: string | undefined;
  currency: string;
  totalValueCents: number;
  startDate?: Date | undefined;
  expectedCompletion?: Date | undefined;
  paymentTerms?: string | undefined;
  status?: string | undefined;
}

export interface UpdateProjectInput {
  title?: string | undefined;
  description?: string | null | undefined;
  currency?: string | undefined;
  totalValueCents?: number | undefined;
  startDate?: Date | null | undefined;
  expectedCompletion?: Date | null | undefined;
  paymentTerms?: string | null | undefined;
  status?: string | undefined;
  clientId?: string | undefined;
  reminderPolicy?: Record<string, unknown> | undefined;
}

export interface AgreementRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly version: number;
  readonly status: string;
  readonly isCurrent: boolean;
  readonly totalAmountCents: number;
  readonly currency: string;
  readonly depositAmountCents: number;
  readonly milestoneSchedule: readonly {
    title: string;
    amountCents: number;
    dueLabel?: string | undefined;
  }[];
  readonly paymentDueDays: number;
  readonly graceDays: number;
  readonly pauseAfterOverdueDays: number;
  readonly acceptedPaymentMethods: readonly string[];
  readonly latePaymentPolicy: Record<string, unknown>;
  readonly workPauseDescription: string;
  readonly releaseCondition: string;
  readonly finalDeliveryDescription: string;
  readonly ownershipMode: string;
  readonly ownershipDescription: string;
  readonly maxRevisionsPerMilestone: number;
  readonly extraRevisionPolicy: string;
  readonly cancellationNoticeDays: number;
  readonly cancellationKillFeeCents?: number | undefined;
  readonly cancellationPolicy: string;
  readonly customClauses?: string | undefined;
  readonly termsText: string;
  readonly hash: string;
  readonly disclaimerVersion: string;
  readonly supersedesId?: string | undefined;
  readonly sentAt?: Date | undefined;
  readonly acceptedAt?: Date | undefined;
  readonly acceptedBy?: string | undefined;
  readonly acceptIpHash?: string | undefined;
  readonly acceptUaHash?: string | undefined;
  readonly voidedAt?: Date | undefined;
  readonly createdAt: Date;
}

export interface CreateAgreementInput {
  version: number;
  status?: string | undefined;
  totalAmountCents: number;
  currency: string;
  depositAmountCents: number;
  milestoneSchedule: readonly {
    title: string;
    amountCents: number;
    dueLabel?: string | undefined;
  }[];
  paymentDueDays: number;
  graceDays: number;
  pauseAfterOverdueDays: number;
  acceptedPaymentMethods: readonly string[];
  latePaymentPolicy: Record<string, unknown>;
  workPauseDescription: string;
  releaseCondition: string;
  finalDeliveryDescription: string;
  ownershipMode: string;
  ownershipDescription: string;
  maxRevisionsPerMilestone: number;
  extraRevisionPolicy: string;
  cancellationNoticeDays: number;
  cancellationKillFeeCents?: number | undefined;
  cancellationPolicy: string;
  customClauses?: string | undefined;
  termsText: string;
  hash: string;
  disclaimerVersion: string;
  supersedesId?: string | undefined;
}

export interface UpdateAgreementLifecycleInput {
  status?: string | undefined;
  isCurrent?: boolean | undefined;
  sentAt?: Date | undefined;
  acceptedAt?: Date | undefined;
  acceptedBy?: string | undefined;
  acceptIpHash?: string | undefined;
  acceptUaHash?: string | undefined;
  voidedAt?: Date | undefined;
}

export interface PortalLinkRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly revokedAt?: Date | undefined;
  readonly createdAt: Date;
}

export interface CreatePortalLinkInput {
  tokenHash: string;
  expiresAt: Date;
}

export interface DeliverableFileEntry {
  readonly key: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256?: string | undefined;
  readonly visibility: "review" | "final";
}

export interface DeliverableRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly milestoneId: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly status: string;
  readonly deliveryState: string;
  readonly stagingUrl?: string | undefined;
  readonly stagingTransferState: string;
  readonly currentVersionNo: number;
  readonly approvedVersionNo?: number | undefined;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateDeliverableInput {
  projectId: string;
  milestoneId: string;
  title: string;
  description?: string | undefined;
}

export interface UpdateDeliverableInput {
  title?: string | undefined;
  description?: string | null | undefined;
  status?: string | undefined;
  deliveryState?: string | undefined;
  stagingUrl?: string | null | undefined;
  stagingTransferState?: string | undefined;
  currentVersionNo?: number | undefined;
  approvedVersionNo?: number | null | undefined;
}

export interface DeliverableVersionRecord {
  readonly id: string;
  readonly deliverableId: string;
  readonly versionNo: number;
  readonly description?: string | undefined;
  readonly files: readonly DeliverableFileEntry[];
  readonly links: readonly string[];
  readonly previewText?: string | undefined;
  readonly stagingUrl?: string | undefined;
  readonly previewArtifactRef?: string | undefined;
  readonly finalArtifactRef?: string | undefined;
  readonly createdBy: string;
  readonly createdAt: Date;
}

export interface CreateDeliverableVersionInput {
  description?: string | undefined;
  files: readonly DeliverableFileEntry[];
  links: readonly string[];
  previewText?: string | undefined;
  stagingUrl?: string | undefined;
  previewArtifactRef?: string | undefined;
  finalArtifactRef?: string | undefined;
  createdBy: string;
}

export type ApprovalDecision = "approved" | "revision_requested" | "rejected" | "disputed";

export interface ApprovalRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly milestoneId: string;
  readonly deliverableId?: string | undefined;
  readonly deliverableVersionId?: string | undefined;
  readonly versionNo?: number | undefined;
  readonly versionRef?: string | undefined;
  readonly decision: ApprovalDecision;
  readonly approverRef: string;
  readonly note?: string | undefined;
  readonly actorType: string;
  readonly actorId?: string | undefined;
  readonly ipHash?: string | undefined;
  readonly uaHash?: string | undefined;
  readonly createdAt: Date;
}

export interface CreateApprovalInput {
  projectId: string;
  milestoneId: string;
  deliverableId?: string | undefined;
  deliverableVersionId?: string | undefined;
  versionNo?: number | undefined;
  versionRef?: string | undefined;
  decision: ApprovalDecision;
  approverRef: string;
  note?: string | undefined;
  actorType?: string | undefined;
  actorId?: string | undefined;
  ipHash?: string | undefined;
  uaHash?: string | undefined;
}

/**
 * Reminder automation row (Session 12). One row per scheduled step per
 * milestone — the full audit trail the task requires:
 * scheduled_at / sent_at / delivery status / recipient / template+version /
 * rendered snapshot / result-error / attempt count / next scheduled action /
 * cancel marker / idempotency key.
 */
export type NotificationStateValue = "queued" | "sent" | "delivered" | "failed" | "bounced";

export interface NotificationRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId?: string | undefined;
  readonly milestoneId?: string | undefined;
  readonly channel: string;
  readonly template: string;
  readonly templateVersion: string;
  readonly subject?: string | undefined;
  readonly bodySnapshot?: string | undefined;
  readonly recipient: string;
  readonly recipientName?: string | undefined;
  readonly state: NotificationStateValue;
  readonly providerMessageId?: string | undefined;
  readonly scheduledFor: Date;
  readonly sentAt?: Date | undefined;
  readonly deliveredAt?: Date | undefined;
  readonly canceledAt?: Date | undefined;
  readonly attemptCount: number;
  readonly lastError?: string | undefined;
  readonly nextActionAt?: Date | undefined;
  readonly nextActionLabel?: string | undefined;
  readonly trigger: string;
  readonly policyStep?: string | undefined;
  readonly policyVersion?: number | undefined;
  /** Session 18 transactional kind (e.g. payment_received, milestone_overdue). */
  readonly kind?: string | undefined;
  /** Session 18 category (payments/approvals/reminders/overdue/pauses/plans/deliverables). */
  readonly category?: string | undefined;
  /** Session 18 in-app read marker. */
  readonly readAt?: Date | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly createdAt: Date;
}

export interface CreateNotificationInput {
  projectId?: string | undefined;
  milestoneId?: string | undefined;
  channel?: string | undefined;
  template: string;
  templateVersion?: string | undefined;
  subject?: string | undefined;
  bodySnapshot?: string | undefined;
  recipient: string;
  recipientName?: string | undefined;
  scheduledFor: Date;
  nextActionAt?: Date | undefined;
  nextActionLabel?: string | undefined;
  trigger?: string | undefined;
  policyStep?: string | undefined;
  policyVersion?: number | undefined;
  kind?: string | undefined;
  category?: string | undefined;
  idempotencyKey?: string | undefined;
}

export interface UpdateNotificationInput {
  state?: NotificationStateValue | undefined;
  providerMessageId?: string | null | undefined;
  sentAt?: Date | null | undefined;
  deliveredAt?: Date | null | undefined;
  canceledAt?: Date | null | undefined;
  attemptCount?: number | undefined;
  lastError?: string | null | undefined;
  nextActionAt?: Date | null | undefined;
  nextActionLabel?: string | null | undefined;
  subject?: string | undefined;
  bodySnapshot?: string | undefined;
  kind?: string | undefined;
  category?: string | undefined;
  readAt?: Date | null | undefined;
}

/**
 * Per-user notification preference (Session 18). One row per
 * (workspace, user, category, channel). Absent = enabled.
 */
export interface NotificationPreferenceRecord {
  readonly workspaceId: string;
  readonly userId: string;
  readonly category: string;
  readonly channel: string;
  readonly enabled: boolean;
  readonly updatedAt: Date;
}

/**
 * Client email opt-out (Session 18). Email is stored normalized
 * (lowercase, trimmed). Category may be a concrete category or "all".
 */
export interface NotificationOptOutRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly email: string;
  readonly category: string;
  readonly createdAt: Date;
}

/**
 * Payment plan row (Session 13). A restructured schedule for an outstanding
 * milestone balance. `originalAmountCents` is write-once (the original
 * obligation snapshot); a modified schedule is a NEW row (bumped `version`,
 * `supersedesId` pointing at the replaced version). Installment rows carry
 * their own status; only `state`/`installments`/`acceptedAt`/`note` may
 * advance through `updatePaymentPlan` (mirrors the no-rewrite invariant).
 */
export type PaymentPlanStateValue =
  "offered" | "accepted" | "active" | "completed" | "defaulted" | "superseded";

export type PaymentPlanInstallmentStatus = "scheduled" | "paid" | "missed" | "canceled";

export interface PaymentPlanInstallmentRecord {
  readonly seq: number;
  readonly amountCents: number;
  readonly dueDate: Date;
  readonly status: PaymentPlanInstallmentStatus;
  readonly paymentId?: string | undefined;
  readonly paidAt?: Date | undefined;
  readonly note?: string | undefined;
}

export interface PaymentPlanRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly milestoneId: string;
  readonly originalAmountCents: number;
  readonly currency: string;
  readonly installments: readonly PaymentPlanInstallmentRecord[];
  readonly state: PaymentPlanStateValue;
  readonly version: number;
  readonly supersedesId?: string | undefined;
  readonly note?: string | undefined;
  readonly offeredAt: Date;
  readonly acceptedAt?: Date | undefined;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreatePaymentPlanInput {
  projectId: string;
  milestoneId: string;
  originalAmountCents: number;
  currency?: string | undefined;
  installments: readonly PaymentPlanInstallmentRecord[];
  version?: number | undefined;
  supersedesId?: string | undefined;
  note?: string | undefined;
}

export interface UpdatePaymentPlanInput {
  state?: PaymentPlanStateValue | undefined;
  installments?: readonly PaymentPlanInstallmentRecord[] | undefined;
  acceptedAt?: Date | null | undefined;
  note?: string | null | undefined;
}

/**
 * Evidence-pack generation row (Session 15). One immutable row per export:
 * the freelancer's point-in-time record for an overdue/disputed project.
 * Each generation is a NEW row (matches the `no_update_evidence` DB guard) —
 * regenerating never overwrites history. The row pins what was true at
 * generation time (agreement hashes, event count, canonical-bytes sha256);
 * the full human-readable snapshot is rebuilt from live records on read and
 * compared against these pins so drift is reported factually.
 */
export interface EvidencePackRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly generatedAt: Date;
  readonly generatedBy: string;
  readonly agreementVersionHashes: readonly string[];
  readonly eventSeqFrom: number;
  readonly eventSeqTo: number;
  readonly artifactRef: string;
  readonly sha256: string;
  readonly disclaimerVersion: string;
}

export interface CreateEvidencePackInput {
  projectId: string;
  generatedBy: string;
  generatedAt?: Date | undefined;
  agreementVersionHashes: readonly string[];
  eventSeqFrom: number;
  eventSeqTo: number;
  artifactRef: string;
  sha256: string;
  disclaimerVersion?: string | undefined;
}

export interface Store {
  createUser(input: CreateUserInput): Promise<UserRecord>;
  findUserByEmail(email: string): Promise<UserRecord | undefined>;
  findUserById(id: string): Promise<UserRecord | undefined>;
  updateUser(
    id: string,
    patch: { displayName?: string; passwordHash?: PasswordHash; lastLoginAt?: Date },
  ): Promise<UserRecord>;
  createWorkspace(ownerUserId: string, input: CreateWorkspaceInput): Promise<WorkspaceRecord>;
  listWorkspacesForUser(userId: string): Promise<WorkspaceRecord[]>;
  findWorkspace(id: string): Promise<WorkspaceRecord | undefined>;
  findMembership(userId: string, workspaceId: string): Promise<MembershipRecord | undefined>;
  listMembers(workspaceId: string): Promise<MembershipRecord[]>;
  addMember(workspaceId: string, userId: string, role: WorkspaceRole): Promise<MembershipRecord>;
  createClient(workspaceId: string, input: CreateClientInput): Promise<ClientRecord>;
  listClients(workspaceId: string): Promise<ClientRecord[]>;
  findClient(id: string): Promise<ClientRecord | undefined>;
  updateClient(id: string, patch: UpdateClientInput): Promise<ClientRecord>;
  createProject(workspaceId: string, input: CreateProjectInput): Promise<ProjectRecord>;
  listProjects(workspaceId: string): Promise<ProjectRecord[]>;
  findProject(id: string): Promise<ProjectRecord | undefined>;
  updateProject(id: string, patch: UpdateProjectInput): Promise<ProjectRecord>;
  listMilestones(projectId: string): Promise<MilestoneRecord[]>;
  createMilestone(
    workspaceId: string,
    projectId: string,
    input: CreateMilestoneInput,
  ): Promise<MilestoneRecord>;
  findMilestone(id: string): Promise<MilestoneRecord | undefined>;
  updateMilestone(id: string, patch: UpdateMilestoneInput): Promise<MilestoneRecord>;
  appendProjectEvent(
    workspaceId: string,
    projectId: string,
    input: AppendProjectEventInput,
  ): Promise<ProjectEventRecord>;
  listPayments(projectId: string): Promise<PaymentRecord[]>;
  findPaymentById(id: string): Promise<PaymentRecord | undefined>;
  findPaymentByProvider(
    provider: string,
    providerPaymentId: string,
  ): Promise<PaymentRecord | undefined>;
  findPaymentByIdempotencyKey(idempotencyKey: string): Promise<PaymentRecord | undefined>;
  createPayment(workspaceId: string, input: CreatePaymentInput): Promise<PaymentRecord>;
  updatePaymentLifecycle(id: string, patch: UpdatePaymentLifecycleInput): Promise<PaymentRecord>;
  listProjectEvents(projectId: string, limit?: number): Promise<ProjectEventRecord[]>;
  findProjectEventById(id: string): Promise<ProjectEventRecord | undefined>;
  createAgreement(
    workspaceId: string,
    projectId: string,
    input: CreateAgreementInput,
  ): Promise<AgreementRecord>;
  listAgreements(projectId: string): Promise<AgreementRecord[]>;
  findAgreement(id: string): Promise<AgreementRecord | undefined>;
  findAgreementByVersion(projectId: string, version: number): Promise<AgreementRecord | undefined>;
  updateAgreementLifecycle(
    id: string,
    patch: UpdateAgreementLifecycleInput,
  ): Promise<AgreementRecord>;
  createPortalLink(
    workspaceId: string,
    projectId: string,
    input: CreatePortalLinkInput,
  ): Promise<PortalLinkRecord>;
  listPortalLinks(projectId: string): Promise<PortalLinkRecord[]>;
  findPortalLinkById(id: string): Promise<PortalLinkRecord | undefined>;
  findPortalLinkByTokenHash(tokenHash: string): Promise<PortalLinkRecord | undefined>;
  revokePortalLink(id: string): Promise<PortalLinkRecord>;
  createDeliverable(workspaceId: string, input: CreateDeliverableInput): Promise<DeliverableRecord>;
  listDeliverablesByMilestone(milestoneId: string): Promise<DeliverableRecord[]>;
  listDeliverablesByProject(projectId: string): Promise<DeliverableRecord[]>;
  findDeliverable(id: string): Promise<DeliverableRecord | undefined>;
  updateDeliverable(id: string, patch: UpdateDeliverableInput): Promise<DeliverableRecord>;
  createDeliverableVersion(
    deliverableId: string,
    input: CreateDeliverableVersionInput,
  ): Promise<DeliverableVersionRecord>;
  listDeliverableVersions(deliverableId: string): Promise<DeliverableVersionRecord[]>;
  findDeliverableVersion(
    deliverableId: string,
    versionNo: number,
  ): Promise<DeliverableVersionRecord | undefined>;
  createApproval(workspaceId: string, input: CreateApprovalInput): Promise<ApprovalRecord>;
  listApprovalsByDeliverable(deliverableId: string): Promise<ApprovalRecord[]>;
  listApprovalsByMilestone(milestoneId: string): Promise<ApprovalRecord[]>;
  listApprovalsByProject(projectId: string): Promise<ApprovalRecord[]>;
  updateWorkspaceReminderDefaults(
    workspaceId: string,
    reminderDefaults: Record<string, unknown>,
  ): Promise<WorkspaceRecord>;
  createNotification(
    workspaceId: string,
    input: CreateNotificationInput,
  ): Promise<NotificationRecord>;
  findNotificationById(id: string): Promise<NotificationRecord | undefined>;
  findNotificationByIdempotencyKey(idempotencyKey: string): Promise<NotificationRecord | undefined>;
  listNotificationsByMilestone(milestoneId: string): Promise<NotificationRecord[]>;
  listNotificationsByProject(projectId: string): Promise<NotificationRecord[]>;
  updateNotification(id: string, patch: UpdateNotificationInput): Promise<NotificationRecord>;
  listWorkspaceNotifications(workspaceId: string, limit?: number): Promise<NotificationRecord[]>;
  listInAppForUser(workspaceId: string, userId: string): Promise<NotificationRecord[]>;
  getNotificationPreferences(
    workspaceId: string,
    userId: string,
  ): Promise<NotificationPreferenceRecord[]>;
  setNotificationPreference(
    workspaceId: string,
    userId: string,
    category: string,
    channel: string,
    enabled: boolean,
  ): Promise<NotificationPreferenceRecord>;
  findNotificationOptOut(
    workspaceId: string,
    email: string,
    category: string,
  ): Promise<NotificationOptOutRecord | undefined>;
  addNotificationOptOut(
    workspaceId: string,
    email: string,
    category: string,
  ): Promise<NotificationOptOutRecord>;
  removeNotificationOptOut(workspaceId: string, email: string, category: string): Promise<void>;
  listNotificationOptOuts(workspaceId: string): Promise<NotificationOptOutRecord[]>;
  createPaymentPlan(workspaceId: string, input: CreatePaymentPlanInput): Promise<PaymentPlanRecord>;
  findPaymentPlan(id: string): Promise<PaymentPlanRecord | undefined>;
  listPaymentPlansByMilestone(milestoneId: string): Promise<PaymentPlanRecord[]>;
  listPaymentPlansByProject(projectId: string): Promise<PaymentPlanRecord[]>;
  updatePaymentPlan(id: string, patch: UpdatePaymentPlanInput): Promise<PaymentPlanRecord>;
  createEvidencePack(
    workspaceId: string,
    input: CreateEvidencePackInput,
  ): Promise<EvidencePackRecord>;
  listEvidencePacksByProject(projectId: string): Promise<EvidencePackRecord[]>;
  findEvidencePack(id: string): Promise<EvidencePackRecord | undefined>;
}

function cloneUser(u: UserRecord): UserRecord {
  return { ...u, passwordHash: { ...u.passwordHash, params: { ...u.passwordHash.params } } };
}

function cloneAgreement(a: AgreementRecord): AgreementRecord {
  return {
    ...a,
    milestoneSchedule: a.milestoneSchedule.map((m) => ({ ...m })),
    acceptedPaymentMethods: [...a.acceptedPaymentMethods],
    latePaymentPolicy: { ...a.latePaymentPolicy },
  };
}

function clonePaymentPlan(p: PaymentPlanRecord): PaymentPlanRecord {
  return {
    ...p,
    installments: p.installments.map((i) => ({ ...i })),
  };
}

function isApprovalDecision(value: string): value is ApprovalDecision {
  return (
    value === "approved" ||
    value === "revision_requested" ||
    value === "rejected" ||
    value === "disputed"
  );
}

/* eslint-disable @typescript-eslint/require-await -- InMemoryStore implements the async Store seam synchronously; methods stay async so callers/tests are identical across backends. */
export class InMemoryStore implements Store {
  private readonly users = new Map<string, UserRecord>();
  private readonly emailIndex = new Map<string, string>();
  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly memberships = new Map<string, MembershipRecord>();
  private readonly clients = new Map<string, ClientRecord>();
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly milestones = new Map<string, MilestoneRecord>();
  private readonly payments = new Map<string, PaymentRecord>();
  private readonly events = new Map<string, ProjectEventRecord>();
  private readonly agreements = new Map<string, AgreementRecord>();
  private readonly portalLinks = new Map<string, PortalLinkRecord>();
  private readonly deliverables = new Map<string, DeliverableRecord>();
  private readonly deliverableVersions = new Map<string, DeliverableVersionRecord>();
  private readonly approvals = new Map<string, ApprovalRecord>();
  private readonly notifications = new Map<string, NotificationRecord>();
  private readonly notificationPreferences = new Map<string, NotificationPreferenceRecord>();
  private readonly notificationOptOuts = new Map<string, NotificationOptOutRecord>();
  private readonly paymentPlans = new Map<string, PaymentPlanRecord>();
  private readonly evidencePacks = new Map<string, EvidencePackRecord>();

  private membershipKey(userId: string, workspaceId: string): string {
    return `${userId}:${workspaceId}`;
  }

  async createUser(input: CreateUserInput): Promise<UserRecord> {
    const email = normalizeEmail(input.email);
    if (this.emailIndex.has(email)) throw AppError.conflict("Email already registered");
    const now = new Date();
    const user: UserRecord = {
      id: randomUUID(),
      email,
      displayName: input.displayName,
      passwordHash: input.passwordHash,
      createdAt: now,
    };
    this.users.set(user.id, cloneUser(user));
    this.emailIndex.set(email, user.id);
    return cloneUser(user);
  }

  async findUserByEmail(email: string): Promise<UserRecord | undefined> {
    const id = this.emailIndex.get(normalizeEmail(email));
    if (!id) return undefined;
    const user = this.users.get(id);
    return user ? cloneUser(user) : undefined;
  }

  async findUserById(id: string): Promise<UserRecord | undefined> {
    const user = this.users.get(id);
    return user ? cloneUser(user) : undefined;
  }

  async updateUser(
    id: string,
    patch: { displayName?: string; passwordHash?: PasswordHash; lastLoginAt?: Date },
  ): Promise<UserRecord> {
    const existing = this.users.get(id);
    if (!existing) throw AppError.notFound("User not found");
    const updated: UserRecord = {
      ...cloneUser(existing),
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      ...(patch.passwordHash !== undefined ? { passwordHash: patch.passwordHash } : {}),
      ...(patch.lastLoginAt !== undefined ? { lastLoginAt: patch.lastLoginAt } : {}),
    };
    this.users.set(id, cloneUser(updated));
    return cloneUser(updated);
  }

  async createWorkspace(
    ownerUserId: string,
    input: CreateWorkspaceInput,
  ): Promise<WorkspaceRecord> {
    const owner = this.users.get(ownerUserId);
    if (!owner) throw AppError.notFound("User not found");
    const now = new Date();
    const workspace: WorkspaceRecord = {
      id: randomUUID(),
      name: input.name,
      ownerUserId,
      createdAt: now,
      reminderDefaults: {},
    };
    this.workspaces.set(workspace.id, { ...workspace });
    this.memberships.set(this.membershipKey(ownerUserId, workspace.id), {
      userId: ownerUserId,
      workspaceId: workspace.id,
      role: "owner",
      createdAt: now,
    });
    return { ...workspace };
  }

  async listWorkspacesForUser(userId: string): Promise<WorkspaceRecord[]> {
    const out: WorkspaceRecord[] = [];
    for (const m of this.memberships.values()) {
      if (m.userId === userId) {
        const ws = this.workspaces.get(m.workspaceId);
        if (ws) out.push({ ...ws });
      }
    }
    return out;
  }

  async findWorkspace(id: string): Promise<WorkspaceRecord | undefined> {
    const ws = this.workspaces.get(id);
    return ws ? { ...ws } : undefined;
  }

  async findMembership(userId: string, workspaceId: string): Promise<MembershipRecord | undefined> {
    const m = this.memberships.get(this.membershipKey(userId, workspaceId));
    return m ? { ...m } : undefined;
  }

  async listMembers(workspaceId: string): Promise<MembershipRecord[]> {
    const out: MembershipRecord[] = [];
    for (const m of this.memberships.values()) {
      if (m.workspaceId === workspaceId) out.push({ ...m });
    }
    return out;
  }

  async addMember(
    workspaceId: string,
    userId: string,
    role: WorkspaceRole,
  ): Promise<MembershipRecord> {
    const key = this.membershipKey(userId, workspaceId);
    if (this.memberships.has(key)) throw AppError.conflict("User is already a member");
    if (!this.workspaces.has(workspaceId)) throw AppError.forbidden();
    if (!this.users.has(userId)) throw AppError.notFound("User not found");
    const record: MembershipRecord = { userId, workspaceId, role, createdAt: new Date() };
    this.memberships.set(key, { ...record });
    return { ...record };
  }

  async createClient(workspaceId: string, input: CreateClientInput): Promise<ClientRecord> {
    if (!this.workspaces.has(workspaceId)) throw AppError.forbidden();
    const email = normalizeEmail(input.email);
    for (const c of this.clients.values()) {
      if (c.workspaceId === workspaceId && c.email === email) {
        throw AppError.conflict("Client email already exists in this workspace");
      }
    }
    const now = new Date();
    const client: ClientRecord = {
      id: randomUUID(),
      workspaceId,
      name: input.name,
      email,
      ...(input.company !== undefined ? { company: input.company } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.billingEmail !== undefined ? { billingEmail: input.billingEmail } : {}),
      ...(input.billingAddress !== undefined ? { billingAddress: input.billingAddress } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      ...(input.country !== undefined ? { country: input.country } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      status: input.status ?? "active",
      createdAt: now,
      updatedAt: now,
    };
    this.clients.set(client.id, { ...client });
    return { ...client };
  }

  async listClients(workspaceId: string): Promise<ClientRecord[]> {
    const out: ClientRecord[] = [];
    for (const c of this.clients.values()) {
      if (c.workspaceId === workspaceId) out.push({ ...c });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  async findClient(id: string): Promise<ClientRecord | undefined> {
    const c = this.clients.get(id);
    return c ? { ...c } : undefined;
  }

  async updateClient(id: string, patch: UpdateClientInput): Promise<ClientRecord> {
    const existing = this.clients.get(id);
    if (!existing) throw AppError.notFound("Client not found");
    const cleared = { ...existing };
    if (patch.company === null) delete cleared.company;
    if (patch.phone === null) delete cleared.phone;
    if (patch.billingEmail === null) delete cleared.billingEmail;
    if (patch.billingAddress === null) delete cleared.billingAddress;
    if (patch.timezone === null) delete cleared.timezone;
    if (patch.country === null) delete cleared.country;
    if (patch.notes === null) delete cleared.notes;
    const updated: ClientRecord = {
      ...cleared,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(typeof patch.company === "string" ? { company: patch.company } : {}),
      ...(typeof patch.phone === "string" ? { phone: patch.phone } : {}),
      ...(typeof patch.billingEmail === "string" ? { billingEmail: patch.billingEmail } : {}),
      ...(typeof patch.billingAddress === "string" ? { billingAddress: patch.billingAddress } : {}),
      ...(typeof patch.timezone === "string" ? { timezone: patch.timezone } : {}),
      ...(typeof patch.country === "string" ? { country: patch.country } : {}),
      ...(typeof patch.notes === "string" ? { notes: patch.notes } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      updatedAt: new Date(),
    };
    this.clients.set(id, { ...updated });
    return { ...updated };
  }

  async createProject(workspaceId: string, input: CreateProjectInput): Promise<ProjectRecord> {
    if (!this.workspaces.has(workspaceId)) throw AppError.forbidden();
    const client = this.clients.get(input.clientId);
    if (!client) throw AppError.notFound("Client not found");
    if (client.workspaceId !== workspaceId) {
      throw AppError.unprocessable("Client does not belong to this workspace");
    }
    const now = new Date();
    const project: ProjectRecord = {
      id: randomUUID(),
      workspaceId,
      clientId: input.clientId,
      title: input.title,
      ...(input.description !== undefined ? { description: input.description } : {}),
      currency: input.currency,
      totalValueCents: input.totalValueCents,
      ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
      ...(input.expectedCompletion !== undefined
        ? { expectedCompletion: input.expectedCompletion }
        : {}),
      ...(input.paymentTerms !== undefined ? { paymentTerms: input.paymentTerms } : {}),
      status: input.status ?? "active",
      reminderPolicy: {},
      createdAt: now,
      updatedAt: now,
    };
    this.projects.set(project.id, { ...project });
    return { ...project };
  }

  async updateWorkspaceReminderDefaults(
    workspaceId: string,
    reminderDefaults: Record<string, unknown>,
  ): Promise<WorkspaceRecord> {
    const existing = this.workspaces.get(workspaceId);
    if (!existing) throw AppError.notFound("Workspace not found");
    const updated: WorkspaceRecord = {
      ...existing,
      reminderDefaults: { ...reminderDefaults },
    };
    this.workspaces.set(workspaceId, { ...updated });
    return { ...updated };
  }

  async listProjects(workspaceId: string): Promise<ProjectRecord[]> {
    const out: ProjectRecord[] = [];
    for (const p of this.projects.values()) {
      if (p.workspaceId === workspaceId) out.push({ ...p });
    }
    out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return out;
  }

  async findProject(id: string): Promise<ProjectRecord | undefined> {
    const p = this.projects.get(id);
    return p ? { ...p } : undefined;
  }

  async updateProject(id: string, patch: UpdateProjectInput): Promise<ProjectRecord> {
    const existing = this.projects.get(id);
    if (!existing) throw AppError.notFound("Project not found");
    if (patch.clientId !== undefined) {
      const client = this.clients.get(patch.clientId);
      if (!client) throw AppError.notFound("Client not found");
      if (client.workspaceId !== existing.workspaceId) {
        throw AppError.unprocessable("Client does not belong to this workspace");
      }
    }
    const updated: ProjectRecord = {
      ...existing,
      ...(patch.clientId !== undefined ? { clientId: patch.clientId } : {}),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined
        ? patch.description === null
          ? { description: undefined }
          : { description: patch.description }
        : {}),
      ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
      ...(patch.totalValueCents !== undefined ? { totalValueCents: patch.totalValueCents } : {}),
      ...(patch.startDate !== undefined
        ? patch.startDate === null
          ? { startDate: undefined }
          : { startDate: patch.startDate }
        : {}),
      ...(patch.expectedCompletion !== undefined
        ? patch.expectedCompletion === null
          ? { expectedCompletion: undefined }
          : { expectedCompletion: patch.expectedCompletion }
        : {}),
      ...(patch.paymentTerms !== undefined
        ? patch.paymentTerms === null
          ? { paymentTerms: undefined }
          : { paymentTerms: patch.paymentTerms }
        : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.reminderPolicy !== undefined
        ? { reminderPolicy: { ...patch.reminderPolicy } }
        : {}),
      updatedAt: new Date(),
    };
    this.projects.set(id, { ...updated });
    return { ...updated };
  }

  async createNotification(
    workspaceId: string,
    input: CreateNotificationInput,
  ): Promise<NotificationRecord> {
    if (!this.workspaces.has(workspaceId)) throw AppError.forbidden();
    if (input.idempotencyKey) {
      for (const n of this.notifications.values()) {
        if (n.workspaceId === workspaceId && n.idempotencyKey === input.idempotencyKey) {
          throw AppError.conflict("Reminder already scheduled for this idempotency key");
        }
      }
    }
    if (input.projectId !== undefined) {
      const project = this.projects.get(input.projectId);
      if (!project) throw AppError.notFound("Project not found");
      if (project.workspaceId !== workspaceId) throw AppError.forbidden();
    }
    const now = new Date();
    const row: NotificationRecord = {
      id: randomUUID(),
      workspaceId,
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.milestoneId !== undefined ? { milestoneId: input.milestoneId } : {}),
      channel: input.channel ?? "email",
      template: input.template,
      templateVersion: input.templateVersion ?? "v1",
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      ...(input.bodySnapshot !== undefined ? { bodySnapshot: input.bodySnapshot } : {}),
      recipient: input.recipient,
      ...(input.recipientName !== undefined ? { recipientName: input.recipientName } : {}),
      state: "queued",
      scheduledFor: input.scheduledFor,
      attemptCount: 0,
      ...(input.nextActionAt !== undefined ? { nextActionAt: input.nextActionAt } : {}),
      ...(input.nextActionLabel !== undefined ? { nextActionLabel: input.nextActionLabel } : {}),
      trigger: input.trigger ?? "schedule",
      ...(input.policyStep !== undefined ? { policyStep: input.policyStep } : {}),
      ...(input.policyVersion !== undefined ? { policyVersion: input.policyVersion } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      createdAt: now,
    };
    this.notifications.set(row.id, { ...row });
    return { ...row };
  }

  async findNotificationById(id: string): Promise<NotificationRecord | undefined> {
    const n = this.notifications.get(id);
    return n ? { ...n } : undefined;
  }

  async findNotificationByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<NotificationRecord | undefined> {
    for (const n of this.notifications.values()) {
      if (n.idempotencyKey === idempotencyKey) return { ...n };
    }
    return undefined;
  }

  async listNotificationsByMilestone(milestoneId: string): Promise<NotificationRecord[]> {
    const out: NotificationRecord[] = [];
    for (const n of this.notifications.values()) {
      if (n.milestoneId === milestoneId) out.push({ ...n });
    }
    out.sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime());
    return out;
  }

  async listNotificationsByProject(projectId: string): Promise<NotificationRecord[]> {
    const out: NotificationRecord[] = [];
    for (const n of this.notifications.values()) {
      if (n.projectId === projectId) out.push({ ...n });
    }
    out.sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime());
    return out;
  }

  async updateNotification(
    id: string,
    patch: UpdateNotificationInput,
  ): Promise<NotificationRecord> {
    const existing = this.notifications.get(id);
    if (!existing) throw AppError.notFound("Notification not found");
    const updated: NotificationRecord = {
      ...existing,
      ...(patch.state !== undefined ? { state: patch.state } : {}),
      ...(patch.providerMessageId !== undefined
        ? patch.providerMessageId === null
          ? { providerMessageId: undefined }
          : { providerMessageId: patch.providerMessageId }
        : {}),
      ...(patch.sentAt !== undefined
        ? patch.sentAt === null
          ? { sentAt: undefined }
          : { sentAt: patch.sentAt }
        : {}),
      ...(patch.deliveredAt !== undefined
        ? patch.deliveredAt === null
          ? { deliveredAt: undefined }
          : { deliveredAt: patch.deliveredAt }
        : {}),
      ...(patch.canceledAt !== undefined
        ? patch.canceledAt === null
          ? { canceledAt: undefined }
          : { canceledAt: patch.canceledAt }
        : {}),
      ...(patch.attemptCount !== undefined ? { attemptCount: patch.attemptCount } : {}),
      ...(patch.lastError !== undefined
        ? patch.lastError === null
          ? { lastError: undefined }
          : { lastError: patch.lastError }
        : {}),
      ...(patch.nextActionAt !== undefined
        ? patch.nextActionAt === null
          ? { nextActionAt: undefined }
          : { nextActionAt: patch.nextActionAt }
        : {}),
      ...(patch.nextActionLabel !== undefined
        ? patch.nextActionLabel === null
          ? { nextActionLabel: undefined }
          : { nextActionLabel: patch.nextActionLabel }
        : {}),
      ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
      ...(patch.bodySnapshot !== undefined ? { bodySnapshot: patch.bodySnapshot } : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.category !== undefined ? { category: patch.category } : {}),
      ...(patch.readAt !== undefined
        ? patch.readAt === null
          ? { readAt: undefined }
          : { readAt: patch.readAt }
        : {}),
    };
    this.notifications.set(id, { ...updated });
    return { ...updated };
  }

  async listWorkspaceNotifications(
    workspaceId: string,
    limit = 100,
  ): Promise<NotificationRecord[]> {
    const out: NotificationRecord[] = [];
    for (const n of this.notifications.values()) {
      if (n.workspaceId === workspaceId) out.push({ ...n });
    }
    out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return out.slice(0, Math.max(1, Math.min(200, limit)));
  }

  async listInAppForUser(workspaceId: string, userId: string): Promise<NotificationRecord[]> {
    const out: NotificationRecord[] = [];
    for (const n of this.notifications.values()) {
      if (n.workspaceId === workspaceId && n.channel === "inapp" && n.recipient === userId) {
        out.push({ ...n });
      }
    }
    out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return out.slice(0, 200);
  }

  private preferenceKey(
    workspaceId: string,
    userId: string,
    category: string,
    channel: string,
  ): string {
    return `${workspaceId}:${userId}:${category}:${channel}`;
  }

  async getNotificationPreferences(
    workspaceId: string,
    userId: string,
  ): Promise<NotificationPreferenceRecord[]> {
    const out: NotificationPreferenceRecord[] = [];
    for (const p of this.notificationPreferences.values()) {
      if (p.workspaceId === workspaceId && p.userId === userId) out.push({ ...p });
    }
    out.sort((a, b) => a.category.localeCompare(b.category) || a.channel.localeCompare(b.channel));
    return out;
  }

  async setNotificationPreference(
    workspaceId: string,
    userId: string,
    category: string,
    channel: string,
    enabled: boolean,
  ): Promise<NotificationPreferenceRecord> {
    if (!this.workspaces.has(workspaceId)) throw AppError.forbidden();
    const key = this.preferenceKey(workspaceId, userId, category, channel);
    const record: NotificationPreferenceRecord = {
      workspaceId,
      userId,
      category,
      channel,
      enabled,
      updatedAt: new Date(),
    };
    this.notificationPreferences.set(key, { ...record });
    return { ...record };
  }

  private optOutKey(workspaceId: string, email: string, category: string): string {
    return `${workspaceId}:${normalizeEmail(email)}:${category}`;
  }

  async findNotificationOptOut(
    workspaceId: string,
    email: string,
    category: string,
  ): Promise<NotificationOptOutRecord | undefined> {
    const exact = this.notificationOptOuts.get(this.optOutKey(workspaceId, email, category));
    if (exact) return { ...exact };
    if (category !== "all") {
      const all = this.notificationOptOuts.get(this.optOutKey(workspaceId, email, "all"));
      if (all) return { ...all };
    }
    return undefined;
  }

  async addNotificationOptOut(
    workspaceId: string,
    email: string,
    category: string,
  ): Promise<NotificationOptOutRecord> {
    if (!this.workspaces.has(workspaceId)) throw AppError.forbidden();
    const normalized = normalizeEmail(email);
    const key = this.optOutKey(workspaceId, normalized, category);
    const existing = this.notificationOptOuts.get(key);
    if (existing) return { ...existing };
    const row: NotificationOptOutRecord = {
      id: randomUUID(),
      workspaceId,
      email: normalized,
      category,
      createdAt: new Date(),
    };
    this.notificationOptOuts.set(key, { ...row });
    return { ...row };
  }

  async removeNotificationOptOut(
    workspaceId: string,
    email: string,
    category: string,
  ): Promise<void> {
    this.notificationOptOuts.delete(this.optOutKey(workspaceId, email, category));
  }

  async listNotificationOptOuts(workspaceId: string): Promise<NotificationOptOutRecord[]> {
    const out: NotificationOptOutRecord[] = [];
    for (const o of this.notificationOptOuts.values()) {
      if (o.workspaceId === workspaceId) out.push({ ...o });
    }
    out.sort((a, b) => a.email.localeCompare(b.email));
    return out;
  }

  async listMilestones(projectId: string): Promise<MilestoneRecord[]> {
    const out: MilestoneRecord[] = [];
    for (const m of this.milestones.values()) {
      if (m.projectId === projectId) out.push({ ...m });
    }
    out.sort((a, b) => a.orderIndex - b.orderIndex);
    return out;
  }

  async createMilestone(
    workspaceId: string,
    projectId: string,
    input: CreateMilestoneInput,
  ): Promise<MilestoneRecord> {
    if (!this.workspaces.has(workspaceId)) throw AppError.forbidden();
    const project = this.projects.get(projectId);
    if (!project) throw AppError.notFound("Project not found");
    if (project.workspaceId !== workspaceId) throw AppError.forbidden();
    for (const m of this.milestones.values()) {
      if (m.projectId === projectId && m.orderIndex === input.orderIndex) {
        throw AppError.conflict(`orderIndex ${input.orderIndex} is already taken`);
      }
    }
    const now = new Date();
    const row: MilestoneRecord = {
      id: randomUUID(),
      workspaceId,
      projectId,
      title: input.title,
      ...(input.description !== undefined ? { description: input.description } : {}),
      amountCents: input.amountCents,
      currency: (input.currency ?? project.currency).toUpperCase(),
      ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
      workState: input.workState ?? "draft",
      paymentState: input.paymentState ?? "unpaid",
      approvalState: input.approvalState ?? "none",
      deliverableState: input.deliverableState ?? "locked",
      unlockState: input.unlockState ?? (input.orderIndex === 0 ? "available" : "locked"),
      appliedPaymentIds: [],
      amountHistory: [],
      ...(input.currentVersionId !== undefined ? { currentVersionId: input.currentVersionId } : {}),
      orderIndex: input.orderIndex,
      createdAt: now,
      updatedAt: now,
    };
    this.milestones.set(row.id, { ...row });
    return { ...row };
  }

  async findMilestone(id: string): Promise<MilestoneRecord | undefined> {
    const m = this.milestones.get(id);
    return m ? { ...m } : undefined;
  }

  async updateMilestone(id: string, patch: UpdateMilestoneInput): Promise<MilestoneRecord> {
    const existing = this.milestones.get(id);
    if (!existing) throw AppError.notFound("Milestone not found");
    if (patch.orderIndex !== undefined && patch.orderIndex !== existing.orderIndex) {
      for (const m of this.milestones.values()) {
        if (m.projectId === existing.projectId && m.orderIndex === patch.orderIndex) {
          throw AppError.conflict(`orderIndex ${patch.orderIndex} is already taken`);
        }
      }
    }
    const updated: MilestoneRecord = {
      ...existing,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined
        ? patch.description === null
          ? { description: undefined }
          : { description: patch.description }
        : {}),
      ...(patch.amountCents !== undefined ? { amountCents: patch.amountCents } : {}),
      ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
      ...(patch.dueDate !== undefined
        ? patch.dueDate === null
          ? { dueDate: undefined }
          : { dueDate: patch.dueDate }
        : {}),
      ...(patch.orderIndex !== undefined ? { orderIndex: patch.orderIndex } : {}),
      ...(patch.workState !== undefined ? { workState: patch.workState } : {}),
      ...(patch.paymentState !== undefined ? { paymentState: patch.paymentState } : {}),
      ...(patch.approvalState !== undefined ? { approvalState: patch.approvalState } : {}),
      ...(patch.deliverableState !== undefined ? { deliverableState: patch.deliverableState } : {}),
      ...(patch.unlockState !== undefined ? { unlockState: patch.unlockState } : {}),
      ...(patch.appliedPaymentIds !== undefined
        ? { appliedPaymentIds: patch.appliedPaymentIds }
        : {}),
      ...(patch.amountHistory !== undefined ? { amountHistory: patch.amountHistory } : {}),
      ...(patch.approvedVersionId !== undefined
        ? patch.approvedVersionId === null
          ? { approvedVersionId: undefined }
          : { approvedVersionId: patch.approvedVersionId }
        : {}),
      ...(patch.currentVersionId !== undefined
        ? patch.currentVersionId === null
          ? { currentVersionId: undefined }
          : { currentVersionId: patch.currentVersionId }
        : {}),
      updatedAt: new Date(),
    };
    this.milestones.set(id, { ...updated });
    return { ...updated };
  }

  async appendProjectEvent(
    workspaceId: string,
    projectId: string,
    input: AppendProjectEventInput,
  ): Promise<ProjectEventRecord> {
    if (input.idempotencyKey) {
      for (const e of this.events.values()) {
        if (
          e.workspaceId === workspaceId &&
          e.projectId === projectId &&
          e.payload.idempotencyKey === input.idempotencyKey
        ) {
          throw AppError.conflict("Event already recorded for this idempotency key");
        }
      }
    }
    const row: ProjectEventRecord = {
      id: randomUUID(),
      workspaceId,
      projectId,
      ...(input.milestoneId !== undefined ? { milestoneId: input.milestoneId } : {}),
      type: input.type,
      actorType: input.actorType,
      occurredAt: input.occurredAt ?? new Date(),
      payload: {
        ...(input.payload ?? {}),
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      },
    };
    this.events.set(row.id, { ...row });
    return { ...row };
  }

  async listPayments(projectId: string): Promise<PaymentRecord[]> {
    const out: PaymentRecord[] = [];
    for (const p of this.payments.values()) {
      if (p.projectId === projectId) out.push({ ...p });
    }
    return out;
  }

  async findPaymentById(id: string): Promise<PaymentRecord | undefined> {
    const p = this.payments.get(id);
    return p ? { ...p } : undefined;
  }

  async findPaymentByProvider(
    provider: string,
    providerPaymentId: string,
  ): Promise<PaymentRecord | undefined> {
    for (const p of this.payments.values()) {
      if (p.provider === provider && p.providerPaymentId === providerPaymentId) {
        return { ...p };
      }
    }
    return undefined;
  }

  async findPaymentByIdempotencyKey(idempotencyKey: string): Promise<PaymentRecord | undefined> {
    for (const p of this.payments.values()) {
      if (p.idempotencyKey === idempotencyKey) return { ...p };
    }
    return undefined;
  }

  async createPayment(workspaceId: string, input: CreatePaymentInput): Promise<PaymentRecord> {
    if (!this.workspaces.has(workspaceId)) throw AppError.forbidden();
    const project = this.projects.get(input.projectId);
    if (!project) throw AppError.notFound("Project not found");
    if (project.workspaceId !== workspaceId) throw AppError.forbidden();
    for (const p of this.payments.values()) {
      if (p.idempotencyKey === input.idempotencyKey) {
        throw AppError.conflict("Payment already exists for this idempotency key");
      }
      if (
        p.provider === (input.provider ?? "stripe") &&
        p.providerPaymentId === input.providerPaymentId
      ) {
        throw AppError.conflict("Payment already exists for this provider payment");
      }
    }
    const now = new Date();
    const row: PaymentRecord = {
      id: input.id ?? randomUUID(),
      workspaceId,
      projectId: input.projectId,
      ...(input.milestoneId !== undefined ? { milestoneId: input.milestoneId } : {}),
      provider: input.provider ?? "stripe",
      providerPaymentId: input.providerPaymentId,
      amountCents: input.amountCents,
      currency: input.currency.toUpperCase(),
      state: input.state ?? "pending",
      idempotencyKey: input.idempotencyKey,
      ...(input.rawWebhookRef !== undefined ? { rawWebhookRef: input.rawWebhookRef } : {}),
      ...(input.receivedAt !== undefined ? { receivedAt: input.receivedAt } : {}),
      createdAt: now,
    };
    this.payments.set(row.id, { ...row });
    return { ...row };
  }

  async updatePaymentLifecycle(
    id: string,
    patch: UpdatePaymentLifecycleInput,
  ): Promise<PaymentRecord> {
    const existing = this.payments.get(id);
    if (!existing) throw AppError.notFound("Payment not found");
    // Lifecycle-only seam (mirrors the DB guard): money/provider linkage is
    // write-once; only state/receivedAt/rawWebhookRef may advance.
    const updated: PaymentRecord = {
      ...existing,
      ...(patch.state !== undefined ? { state: patch.state } : {}),
      ...(patch.rawWebhookRef !== undefined ? { rawWebhookRef: patch.rawWebhookRef } : {}),
      ...(patch.receivedAt !== undefined ? { receivedAt: patch.receivedAt } : {}),
    };
    this.payments.set(id, { ...updated });
    return { ...updated };
  }

  async listProjectEvents(projectId: string, limit = 20): Promise<ProjectEventRecord[]> {
    const out: ProjectEventRecord[] = [];
    for (const e of this.events.values()) {
      if (e.projectId === projectId) out.push({ ...e });
    }
    out.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
    return out.slice(0, Math.max(1, Math.min(500, limit)));
  }

  async findProjectEventById(id: string): Promise<ProjectEventRecord | undefined> {
    const e = this.events.get(id);
    return e ? { ...e } : undefined;
  }

  async createAgreement(
    workspaceId: string,
    projectId: string,
    input: CreateAgreementInput,
  ): Promise<AgreementRecord> {
    if (!this.workspaces.has(workspaceId)) throw AppError.forbidden();
    const project = this.projects.get(projectId);
    if (!project) throw AppError.notFound("Project not found");
    if (project.workspaceId !== workspaceId) throw AppError.forbidden();
    for (const a of this.agreements.values()) {
      if (a.projectId === projectId && a.version === input.version) {
        throw AppError.conflict(`Agreement version ${input.version} already exists`);
      }
    }
    const now = new Date();
    const row: AgreementRecord = {
      id: randomUUID(),
      workspaceId,
      projectId,
      version: input.version,
      status: input.status ?? "draft",
      isCurrent: true,
      totalAmountCents: input.totalAmountCents,
      currency: input.currency,
      depositAmountCents: input.depositAmountCents,
      milestoneSchedule: input.milestoneSchedule.map((m) => ({ ...m })),
      paymentDueDays: input.paymentDueDays,
      graceDays: input.graceDays,
      pauseAfterOverdueDays: input.pauseAfterOverdueDays,
      acceptedPaymentMethods: [...input.acceptedPaymentMethods],
      latePaymentPolicy: { ...input.latePaymentPolicy },
      workPauseDescription: input.workPauseDescription,
      releaseCondition: input.releaseCondition,
      finalDeliveryDescription: input.finalDeliveryDescription,
      ownershipMode: input.ownershipMode,
      ownershipDescription: input.ownershipDescription,
      maxRevisionsPerMilestone: input.maxRevisionsPerMilestone,
      extraRevisionPolicy: input.extraRevisionPolicy,
      cancellationNoticeDays: input.cancellationNoticeDays,
      ...(input.cancellationKillFeeCents !== undefined
        ? { cancellationKillFeeCents: input.cancellationKillFeeCents }
        : {}),
      cancellationPolicy: input.cancellationPolicy,
      ...(input.customClauses !== undefined ? { customClauses: input.customClauses } : {}),
      termsText: input.termsText,
      hash: input.hash,
      disclaimerVersion: input.disclaimerVersion,
      ...(input.supersedesId !== undefined ? { supersedesId: input.supersedesId } : {}),
      createdAt: now,
    };
    this.agreements.set(row.id, cloneAgreement(row));
    return cloneAgreement(row);
  }

  async listAgreements(projectId: string): Promise<AgreementRecord[]> {
    const out: AgreementRecord[] = [];
    for (const a of this.agreements.values()) {
      if (a.projectId === projectId) out.push(cloneAgreement(a));
    }
    out.sort((a, b) => a.version - b.version);
    return out;
  }

  async findAgreement(id: string): Promise<AgreementRecord | undefined> {
    const a = this.agreements.get(id);
    return a ? cloneAgreement(a) : undefined;
  }

  async findAgreementByVersion(
    projectId: string,
    version: number,
  ): Promise<AgreementRecord | undefined> {
    for (const a of this.agreements.values()) {
      if (a.projectId === projectId && a.version === version) return cloneAgreement(a);
    }
    return undefined;
  }

  async updateAgreementLifecycle(
    id: string,
    patch: UpdateAgreementLifecycleInput,
  ): Promise<AgreementRecord> {
    const existing = this.agreements.get(id);
    if (!existing) throw AppError.notFound("Agreement not found");
    // Lifecycle-only seam: business content cannot change through this method
    // (mirrors the DB guard trigger — corrections are new versions).
    const updated: AgreementRecord = {
      ...cloneAgreement(existing),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.isCurrent !== undefined ? { isCurrent: patch.isCurrent } : {}),
      ...(patch.sentAt !== undefined ? { sentAt: patch.sentAt } : {}),
      ...(patch.acceptedAt !== undefined ? { acceptedAt: patch.acceptedAt } : {}),
      ...(patch.acceptedBy !== undefined ? { acceptedBy: patch.acceptedBy } : {}),
      ...(patch.acceptIpHash !== undefined ? { acceptIpHash: patch.acceptIpHash } : {}),
      ...(patch.acceptUaHash !== undefined ? { acceptUaHash: patch.acceptUaHash } : {}),
      ...(patch.voidedAt !== undefined ? { voidedAt: patch.voidedAt } : {}),
    };
    this.agreements.set(id, cloneAgreement(updated));
    return cloneAgreement(updated);
  }

  async createPortalLink(
    workspaceId: string,
    projectId: string,
    input: CreatePortalLinkInput,
  ): Promise<PortalLinkRecord> {
    if (!this.workspaces.has(workspaceId)) throw AppError.forbidden();
    const project = this.projects.get(projectId);
    if (!project) throw AppError.notFound("Project not found");
    if (project.workspaceId !== workspaceId) throw AppError.forbidden();
    for (const l of this.portalLinks.values()) {
      if (l.tokenHash === input.tokenHash) throw AppError.conflict("Portal link already exists");
    }
    const now = new Date();
    const row: PortalLinkRecord = {
      id: randomUUID(),
      workspaceId,
      projectId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      createdAt: now,
    };
    this.portalLinks.set(row.id, { ...row });
    return { ...row };
  }

  async listPortalLinks(projectId: string): Promise<PortalLinkRecord[]> {
    const out: PortalLinkRecord[] = [];
    for (const l of this.portalLinks.values()) {
      if (l.projectId === projectId) out.push({ ...l });
    }
    out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return out;
  }

  async findPortalLinkById(id: string): Promise<PortalLinkRecord | undefined> {
    const l = this.portalLinks.get(id);
    return l ? { ...l } : undefined;
  }

  async findPortalLinkByTokenHash(tokenHash: string): Promise<PortalLinkRecord | undefined> {
    for (const l of this.portalLinks.values()) {
      if (l.tokenHash === tokenHash) return { ...l };
    }
    return undefined;
  }

  async revokePortalLink(id: string): Promise<PortalLinkRecord> {
    const existing = this.portalLinks.get(id);
    if (!existing) throw AppError.notFound("Portal link not found");
    if (existing.revokedAt) return { ...existing };
    const updated: PortalLinkRecord = { ...existing, revokedAt: new Date() };
    this.portalLinks.set(id, { ...updated });
    return { ...updated };
  }

  async createDeliverable(
    workspaceId: string,
    input: CreateDeliverableInput,
  ): Promise<DeliverableRecord> {
    if (!this.workspaces.has(workspaceId)) throw AppError.forbidden();
    const project = this.projects.get(input.projectId);
    if (!project) throw AppError.notFound("Project not found");
    if (project.workspaceId !== workspaceId) throw AppError.forbidden();
    const milestone = this.milestones.get(input.milestoneId);
    if (!milestone) throw AppError.notFound("Milestone not found");
    if (milestone.projectId !== input.projectId) throw AppError.notFound("Milestone not found");
    const now = new Date();
    const row: DeliverableRecord = {
      id: randomUUID(),
      workspaceId,
      projectId: input.projectId,
      milestoneId: input.milestoneId,
      title: input.title.trim(),
      ...(input.description !== undefined ? { description: input.description } : {}),
      status: "draft",
      deliveryState: "locked",
      stagingTransferState: "none",
      currentVersionNo: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.deliverables.set(row.id, { ...row });
    return { ...row };
  }

  async listDeliverablesByMilestone(milestoneId: string): Promise<DeliverableRecord[]> {
    const out: DeliverableRecord[] = [];
    for (const d of this.deliverables.values()) {
      if (d.milestoneId === milestoneId) out.push({ ...d });
    }
    out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return out;
  }

  async listDeliverablesByProject(projectId: string): Promise<DeliverableRecord[]> {
    const out: DeliverableRecord[] = [];
    for (const d of this.deliverables.values()) {
      if (d.projectId === projectId) out.push({ ...d });
    }
    out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return out;
  }

  async findDeliverable(id: string): Promise<DeliverableRecord | undefined> {
    const d = this.deliverables.get(id);
    return d ? { ...d } : undefined;
  }

  async updateDeliverable(id: string, patch: UpdateDeliverableInput): Promise<DeliverableRecord> {
    const existing = this.deliverables.get(id);
    if (!existing) throw AppError.notFound("Deliverable not found");
    const updated: DeliverableRecord = {
      ...existing,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined
        ? patch.description === null
          ? { description: undefined }
          : { description: patch.description }
        : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.deliveryState !== undefined ? { deliveryState: patch.deliveryState } : {}),
      ...(patch.stagingUrl !== undefined
        ? patch.stagingUrl === null
          ? { stagingUrl: undefined }
          : { stagingUrl: patch.stagingUrl }
        : {}),
      ...(patch.stagingTransferState !== undefined
        ? { stagingTransferState: patch.stagingTransferState }
        : {}),
      ...(patch.currentVersionNo !== undefined ? { currentVersionNo: patch.currentVersionNo } : {}),
      ...(patch.approvedVersionNo !== undefined
        ? patch.approvedVersionNo === null
          ? { approvedVersionNo: undefined }
          : { approvedVersionNo: patch.approvedVersionNo }
        : {}),
      updatedAt: new Date(),
    };
    this.deliverables.set(id, { ...updated });
    return { ...updated };
  }

  async createDeliverableVersion(
    deliverableId: string,
    input: CreateDeliverableVersionInput,
  ): Promise<DeliverableVersionRecord> {
    const deliverable = this.deliverables.get(deliverableId);
    if (!deliverable) throw AppError.notFound("Deliverable not found");
    const versionNo = deliverable.currentVersionNo + 1;
    for (const v of this.deliverableVersions.values()) {
      if (v.deliverableId === deliverableId && v.versionNo === versionNo) {
        throw AppError.conflict(`Version ${versionNo} already exists`);
      }
    }
    const row: DeliverableVersionRecord = {
      id: randomUUID(),
      deliverableId,
      versionNo,
      ...(input.description !== undefined ? { description: input.description } : {}),
      files: input.files.map((f) => ({ ...f })),
      links: [...input.links],
      ...(input.previewText !== undefined ? { previewText: input.previewText } : {}),
      ...(input.stagingUrl !== undefined ? { stagingUrl: input.stagingUrl } : {}),
      ...(input.previewArtifactRef !== undefined
        ? { previewArtifactRef: input.previewArtifactRef }
        : {}),
      ...(input.finalArtifactRef !== undefined ? { finalArtifactRef: input.finalArtifactRef } : {}),
      createdBy: input.createdBy,
      createdAt: new Date(),
    };
    this.deliverableVersions.set(row.id, {
      ...row,
      files: row.files.map((f) => ({ ...f })),
      links: [...row.links],
    });
    const updated: DeliverableRecord = {
      ...deliverable,
      currentVersionNo: versionNo,
      updatedAt: new Date(),
    };
    this.deliverables.set(deliverableId, { ...updated });
    return {
      ...row,
      files: row.files.map((f) => ({ ...f })),
      links: [...row.links],
    };
  }

  async listDeliverableVersions(deliverableId: string): Promise<DeliverableVersionRecord[]> {
    const out: DeliverableVersionRecord[] = [];
    for (const v of this.deliverableVersions.values()) {
      if (v.deliverableId === deliverableId) {
        out.push({ ...v, files: v.files.map((f) => ({ ...f })), links: [...v.links] });
      }
    }
    out.sort((a, b) => a.versionNo - b.versionNo);
    return out;
  }

  async findDeliverableVersion(
    deliverableId: string,
    versionNo: number,
  ): Promise<DeliverableVersionRecord | undefined> {
    for (const v of this.deliverableVersions.values()) {
      if (v.deliverableId === deliverableId && v.versionNo === versionNo) {
        return { ...v, files: v.files.map((f) => ({ ...f })), links: [...v.links] };
      }
    }
    return undefined;
  }

  async createApproval(workspaceId: string, input: CreateApprovalInput): Promise<ApprovalRecord> {
    if (!this.workspaces.has(workspaceId)) throw AppError.forbidden();
    const project = this.projects.get(input.projectId);
    if (!project) throw AppError.notFound("Project not found");
    if (project.workspaceId !== workspaceId) throw AppError.forbidden();
    const milestone = this.milestones.get(input.milestoneId);
    if (!milestone) throw AppError.notFound("Milestone not found");
    if (milestone.projectId !== input.projectId) throw AppError.notFound("Milestone not found");
    const hasVersionNo =
      input.versionNo !== undefined && Number.isInteger(input.versionNo) && input.versionNo >= 1;
    const hasVersionRef = input.versionRef !== undefined && input.versionRef.trim().length > 0;
    if ((!hasVersionNo && !hasVersionRef) || (hasVersionNo && hasVersionRef)) {
      throw AppError.unprocessable("Approval must pin exactly one version.");
    }
    if (!isApprovalDecision(input.decision)) {
      throw AppError.unprocessable("Unknown approval decision.");
    }
    const note = input.note?.trim();
    if (
      (input.decision === "revision_requested" ||
        input.decision === "rejected" ||
        input.decision === "disputed") &&
      (!note || note.length < 3)
    ) {
      throw AppError.unprocessable(
        "A note of at least 3 characters is required for this decision.",
      );
    }
    if (input.deliverableId !== undefined) {
      const d = this.deliverables.get(input.deliverableId);
      if (!d) throw AppError.notFound("Deliverable not found");
      if (d.projectId !== input.projectId) throw AppError.notFound("Deliverable not found");
    }
    const row: ApprovalRecord = {
      id: randomUUID(),
      workspaceId,
      projectId: input.projectId,
      milestoneId: input.milestoneId,
      ...(input.deliverableId !== undefined ? { deliverableId: input.deliverableId } : {}),
      ...(input.deliverableVersionId !== undefined
        ? { deliverableVersionId: input.deliverableVersionId }
        : {}),
      ...(input.versionNo !== undefined && Number.isInteger(input.versionNo) && input.versionNo >= 1
        ? { versionNo: input.versionNo }
        : {}),
      ...(input.versionRef !== undefined && input.versionRef.trim().length > 0
        ? { versionRef: input.versionRef.trim() }
        : {}),
      decision: input.decision,
      approverRef: input.approverRef,
      ...(note && note.length > 0 ? { note } : {}),
      actorType: input.actorType ?? "client",
      ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
      ...(input.ipHash !== undefined ? { ipHash: input.ipHash } : {}),
      ...(input.uaHash !== undefined ? { uaHash: input.uaHash } : {}),
      createdAt: new Date(),
    };
    this.approvals.set(row.id, { ...row });
    return { ...row };
  }

  async listApprovalsByDeliverable(deliverableId: string): Promise<ApprovalRecord[]> {
    const out: ApprovalRecord[] = [];
    for (const a of this.approvals.values()) {
      if (a.deliverableId === deliverableId) out.push({ ...a });
    }
    out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return out;
  }

  async listApprovalsByMilestone(milestoneId: string): Promise<ApprovalRecord[]> {
    const out: ApprovalRecord[] = [];
    for (const a of this.approvals.values()) {
      if (a.milestoneId === milestoneId) out.push({ ...a });
    }
    out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return out;
  }

  async listApprovalsByProject(projectId: string): Promise<ApprovalRecord[]> {
    const out: ApprovalRecord[] = [];
    for (const a of this.approvals.values()) {
      if (a.projectId === projectId) out.push({ ...a });
    }
    out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return out;
  }

  async createPaymentPlan(
    workspaceId: string,
    input: CreatePaymentPlanInput,
  ): Promise<PaymentPlanRecord> {
    if (!this.workspaces.has(workspaceId)) throw AppError.forbidden();
    const project = this.projects.get(input.projectId);
    if (!project) throw AppError.notFound("Project not found");
    if (project.workspaceId !== workspaceId) throw AppError.forbidden();
    const milestone = this.milestones.get(input.milestoneId);
    if (!milestone) throw AppError.notFound("Milestone not found");
    if (milestone.projectId !== input.projectId) throw AppError.notFound("Milestone not found");
    if (!Number.isInteger(input.originalAmountCents) || input.originalAmountCents <= 0) {
      throw AppError.unprocessable("originalAmountCents must be a positive integer");
    }
    const now = new Date();
    const row: PaymentPlanRecord = {
      id: randomUUID(),
      workspaceId,
      projectId: input.projectId,
      milestoneId: input.milestoneId,
      originalAmountCents: input.originalAmountCents,
      currency: (input.currency ?? milestone.currency).toUpperCase(),
      installments: input.installments.map((i) => ({
        seq: i.seq,
        amountCents: i.amountCents,
        dueDate: i.dueDate,
        status: i.status,
        ...(i.paymentId !== undefined ? { paymentId: i.paymentId } : {}),
        ...(i.paidAt !== undefined ? { paidAt: i.paidAt } : {}),
        ...(i.note !== undefined ? { note: i.note } : {}),
      })),
      state: "offered",
      version: input.version ?? 1,
      ...(input.supersedesId !== undefined ? { supersedesId: input.supersedesId } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      offeredAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.paymentPlans.set(row.id, clonePaymentPlan(row));
    return clonePaymentPlan(row);
  }

  async findPaymentPlan(id: string): Promise<PaymentPlanRecord | undefined> {
    const p = this.paymentPlans.get(id);
    return p ? clonePaymentPlan(p) : undefined;
  }

  async listPaymentPlansByMilestone(milestoneId: string): Promise<PaymentPlanRecord[]> {
    const out: PaymentPlanRecord[] = [];
    for (const p of this.paymentPlans.values()) {
      if (p.milestoneId === milestoneId) out.push(clonePaymentPlan(p));
    }
    out.sort((a, b) => a.version - b.version);
    return out;
  }

  async listPaymentPlansByProject(projectId: string): Promise<PaymentPlanRecord[]> {
    const out: PaymentPlanRecord[] = [];
    for (const p of this.paymentPlans.values()) {
      if (p.projectId === projectId) out.push(clonePaymentPlan(p));
    }
    out.sort((a, b) => a.version - b.version);
    return out;
  }

  async updatePaymentPlan(id: string, patch: UpdatePaymentPlanInput): Promise<PaymentPlanRecord> {
    const existing = this.paymentPlans.get(id);
    if (!existing) throw AppError.notFound("Payment plan not found");
    // Lifecycle-only seam (mirrors the no-rewrite invariant): the original
    // obligation, currency, version and lineage cannot change through this
    // method — modified schedules are new rows, never edits.
    const updated: PaymentPlanRecord = {
      ...clonePaymentPlan(existing),
      ...(patch.state !== undefined ? { state: patch.state } : {}),
      ...(patch.installments !== undefined
        ? {
            installments: patch.installments.map((i) => ({
              seq: i.seq,
              amountCents: i.amountCents,
              dueDate: i.dueDate,
              status: i.status,
              ...(i.paymentId !== undefined ? { paymentId: i.paymentId } : {}),
              ...(i.paidAt !== undefined ? { paidAt: i.paidAt } : {}),
              ...(i.note !== undefined ? { note: i.note } : {}),
            })),
          }
        : {}),
      ...(patch.acceptedAt !== undefined
        ? patch.acceptedAt === null
          ? { acceptedAt: undefined }
          : { acceptedAt: patch.acceptedAt }
        : {}),
      ...(patch.note !== undefined
        ? patch.note === null
          ? { note: undefined }
          : { note: patch.note }
        : {}),
      updatedAt: new Date(),
    };
    this.paymentPlans.set(id, clonePaymentPlan(updated));
    return clonePaymentPlan(updated);
  }

  async createEvidencePack(
    workspaceId: string,
    input: CreateEvidencePackInput,
  ): Promise<EvidencePackRecord> {
    if (!this.workspaces.has(workspaceId)) throw AppError.forbidden();
    const project = this.projects.get(input.projectId);
    if (!project) throw AppError.notFound("Project not found");
    if (project.workspaceId !== workspaceId) throw AppError.forbidden();
    const now = new Date();
    const row: EvidencePackRecord = {
      id: randomUUID(),
      workspaceId,
      projectId: input.projectId,
      generatedAt: input.generatedAt ?? now,
      generatedBy: input.generatedBy,
      agreementVersionHashes: [...input.agreementVersionHashes],
      eventSeqFrom: input.eventSeqFrom,
      eventSeqTo: input.eventSeqTo,
      artifactRef: input.artifactRef,
      sha256: input.sha256,
      disclaimerVersion: input.disclaimerVersion ?? "v1",
    };
    this.evidencePacks.set(row.id, {
      ...row,
      agreementVersionHashes: [...row.agreementVersionHashes],
    });
    return { ...row, agreementVersionHashes: [...row.agreementVersionHashes] };
  }

  async listEvidencePacksByProject(projectId: string): Promise<EvidencePackRecord[]> {
    const out: EvidencePackRecord[] = [];
    for (const p of this.evidencePacks.values()) {
      if (p.projectId === projectId) {
        out.push({ ...p, agreementVersionHashes: [...p.agreementVersionHashes] });
      }
    }
    out.sort((a, b) => b.generatedAt.getTime() - a.generatedAt.getTime());
    return out;
  }

  async findEvidencePack(id: string): Promise<EvidencePackRecord | undefined> {
    const p = this.evidencePacks.get(id);
    return p ? { ...p, agreementVersionHashes: [...p.agreementVersionHashes] } : undefined;
  }

  /** Test/dev seam: seed a milestone so the command-center has a "current milestone". */
  async seedMilestone(
    input: Omit<
      MilestoneRecord,
      | "id"
      | "createdAt"
      | "updatedAt"
      | "currency"
      | "approvalState"
      | "deliverableState"
      | "unlockState"
      | "appliedPaymentIds"
      | "amountHistory"
    > &
      Partial<
        Pick<
          MilestoneRecord,
          | "id"
          | "createdAt"
          | "updatedAt"
          | "currency"
          | "approvalState"
          | "deliverableState"
          | "unlockState"
          | "appliedPaymentIds"
          | "amountHistory"
        >
      >,
  ): Promise<MilestoneRecord> {
    const now = new Date();
    const row: MilestoneRecord = {
      id: input.id ?? randomUUID(),
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      title: input.title,
      ...(input.description !== undefined ? { description: input.description } : {}),
      amountCents: input.amountCents,
      currency: input.currency ?? "USD",
      ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
      workState: input.workState,
      paymentState: input.paymentState,
      approvalState: input.approvalState ?? "none",
      deliverableState: input.deliverableState ?? "locked",
      unlockState: input.unlockState ?? (input.orderIndex === 0 ? "available" : "locked"),
      appliedPaymentIds: input.appliedPaymentIds ?? [],
      amountHistory: input.amountHistory ?? [],
      ...(input.approvedVersionId !== undefined
        ? { approvedVersionId: input.approvedVersionId }
        : {}),
      ...(input.currentVersionId !== undefined ? { currentVersionId: input.currentVersionId } : {}),
      orderIndex: input.orderIndex,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    };
    this.milestones.set(row.id, { ...row });
    return { ...row };
  }

  /** Test/dev seam: seed a verified payment (no provider wiring yet). */
  async seedPayment(
    input: Omit<
      PaymentRecord,
      "id" | "createdAt" | "provider" | "providerPaymentId" | "currency" | "idempotencyKey"
    > &
      Partial<
        Pick<
          PaymentRecord,
          "provider" | "providerPaymentId" | "currency" | "idempotencyKey" | "createdAt"
        >
      >,
  ): Promise<PaymentRecord> {
    const row: PaymentRecord = {
      ...input,
      id: randomUUID(),
      provider: input.provider ?? "stripe",
      providerPaymentId: input.providerPaymentId ?? `seed_${randomUUID()}`,
      currency: (input.currency ?? "USD").toUpperCase(),
      idempotencyKey: input.idempotencyKey ?? `seed_${randomUUID()}`,
      createdAt: input.createdAt ?? new Date(),
    };
    this.payments.set(row.id, { ...row });
    return { ...row };
  }

  /** Test/dev seam: append a timeline event for recent-activity. */
  async seedEvent(input: Omit<ProjectEventRecord, "id">): Promise<ProjectEventRecord> {
    const row: ProjectEventRecord = { ...input, id: randomUUID() };
    this.events.set(row.id, { ...row });
    return { ...row };
  }

  clear(): void {
    this.users.clear();
    this.emailIndex.clear();
    this.workspaces.clear();
    this.memberships.clear();
    this.clients.clear();
    this.projects.clear();
    this.milestones.clear();
    this.payments.clear();
    this.events.clear();
    this.agreements.clear();
    this.portalLinks.clear();
    this.deliverables.clear();
    this.deliverableVersions.clear();
    this.approvals.clear();
    this.notifications.clear();
    this.notificationPreferences.clear();
    this.notificationOptOuts.clear();
    this.paymentPlans.clear();
    this.evidencePacks.clear();
  }
}
/* eslint-enable @typescript-eslint/require-await */

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === "P2002";
}

function toWorkspaceRole(value: string): WorkspaceRole {
  if (value === "owner" || value === "member" || value === "accountant_readonly") return value;
  throw AppError.internal("Unknown workspace role");
}

/**
 * Postgres-backed store. Used in production; tests use InMemoryStore so the
 * suite runs without Docker. All Prisma errors collapse to typed AppErrors —
 * unique violations become CONFLICT, everything else INTERNAL (no leak).
 */
export class PrismaStore implements Store {
  async createUser(input: CreateUserInput): Promise<UserRecord> {
    const { getPrisma } = await import("../db/prisma.js");
    const prisma = getPrisma();
    try {
      const row = await prisma.user.create({
        data: {
          email: normalizeEmail(input.email),
          displayName: input.displayName,
          passwordHash: input.passwordHash as unknown as Prisma.InputJsonValue,
        },
      });
      return {
        id: row.id,
        email: row.email,
        displayName: row.displayName,
        passwordHash: row.passwordHash as unknown as PasswordHash,
        createdAt: row.createdAt,
        ...(row.lastLoginAt ? { lastLoginAt: row.lastLoginAt } : {}),
      };
    } catch (err: unknown) {
      if (isUniqueViolation(err)) throw AppError.conflict("Email already registered");
      throw err;
    }
  }

  async findUserByEmail(email: string): Promise<UserRecord | undefined> {
    const { getPrisma } = await import("../db/prisma.js");
    const row = await getPrisma().user.findUnique({ where: { email: normalizeEmail(email) } });
    if (!row?.passwordHash) return undefined;
    return {
      id: row.id,
      email: row.email,
      displayName: row.displayName,
      passwordHash: row.passwordHash as unknown as PasswordHash,
      createdAt: row.createdAt,
      ...(row.lastLoginAt ? { lastLoginAt: row.lastLoginAt } : {}),
    };
  }

  async findUserById(id: string): Promise<UserRecord | undefined> {
    const { getPrisma } = await import("../db/prisma.js");
    const row = await getPrisma().user.findUnique({ where: { id } });
    if (!row?.passwordHash) return undefined;
    return {
      id: row.id,
      email: row.email,
      displayName: row.displayName,
      passwordHash: row.passwordHash as unknown as PasswordHash,
      createdAt: row.createdAt,
      ...(row.lastLoginAt ? { lastLoginAt: row.lastLoginAt } : {}),
    };
  }

  async updateUser(
    id: string,
    patch: { displayName?: string; passwordHash?: PasswordHash; lastLoginAt?: Date },
  ): Promise<UserRecord> {
    const { getPrisma } = await import("../db/prisma.js");
    const row = await getPrisma().user.update({
      where: { id },
      data: {
        ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
        ...(patch.passwordHash !== undefined
          ? { passwordHash: patch.passwordHash as unknown as Prisma.InputJsonValue }
          : {}),
        ...(patch.lastLoginAt !== undefined ? { lastLoginAt: patch.lastLoginAt } : {}),
      },
    });
    return {
      id: row.id,
      email: row.email,
      displayName: row.displayName,
      passwordHash: row.passwordHash as unknown as PasswordHash,
      createdAt: row.createdAt,
      ...(row.lastLoginAt ? { lastLoginAt: row.lastLoginAt } : {}),
    };
  }

  async createWorkspace(
    ownerUserId: string,
    input: CreateWorkspaceInput,
  ): Promise<WorkspaceRecord> {
    const { getPrisma } = await import("../db/prisma.js");
    const prisma = getPrisma();
    const row = await prisma.workspace.create({
      data: {
        name: input.name,
        ownerUserId,
        members: { create: { userId: ownerUserId, role: "owner" } },
      },
    });
    return {
      id: row.id,
      name: row.name,
      ownerUserId: row.ownerUserId,
      createdAt: row.createdAt,
      reminderDefaults: parseReminderDefaults(row.reminderDefaults),
    };
  }

  async updateWorkspaceReminderDefaults(
    workspaceId: string,
    reminderDefaults: Record<string, unknown>,
  ): Promise<WorkspaceRecord> {
    const { getPrisma } = await import("../db/prisma.js");
    const row = await getPrisma().workspace.update({
      where: { id: workspaceId },
      data: { reminderDefaults: { ...reminderDefaults } as never },
    });
    return {
      id: row.id,
      name: row.name,
      ownerUserId: row.ownerUserId,
      createdAt: row.createdAt,
      reminderDefaults: parseReminderDefaults(row.reminderDefaults),
    };
  }

  async listWorkspacesForUser(userId: string): Promise<WorkspaceRecord[]> {
    const { getPrisma } = await import("../db/prisma.js");
    const rows = await getPrisma().workspaceMember.findMany({
      where: { userId },
      include: { workspace: true },
    });
    return rows.map((r) => ({
      id: r.workspace.id,
      name: r.workspace.name,
      ownerUserId: r.workspace.ownerUserId,
      createdAt: r.workspace.createdAt,
      reminderDefaults: parseReminderDefaults(r.workspace.reminderDefaults),
    }));
  }

  async findWorkspace(id: string): Promise<WorkspaceRecord | undefined> {
    const { getPrisma } = await import("../db/prisma.js");
    const row = await getPrisma().workspace.findUnique({ where: { id } });
    if (!row) return undefined;
    return {
      id: row.id,
      name: row.name,
      ownerUserId: row.ownerUserId,
      createdAt: row.createdAt,
      reminderDefaults: parseReminderDefaults(row.reminderDefaults),
    };
  }

  async findMembership(userId: string, workspaceId: string): Promise<MembershipRecord | undefined> {
    const { getPrisma } = await import("../db/prisma.js");
    const row = await getPrisma().workspaceMember.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
    });
    if (!row) return undefined;
    return {
      userId: row.userId,
      workspaceId: row.workspaceId,
      role: toWorkspaceRole(row.role),
      createdAt: row.createdAt,
    };
  }

  async listMembers(workspaceId: string): Promise<MembershipRecord[]> {
    const { getPrisma } = await import("../db/prisma.js");
    const rows = await getPrisma().workspaceMember.findMany({ where: { workspaceId } });
    return rows.map((row) => ({
      userId: row.userId,
      workspaceId: row.workspaceId,
      role: toWorkspaceRole(row.role),
      createdAt: row.createdAt,
    }));
  }

  async addMember(
    workspaceId: string,
    userId: string,
    role: WorkspaceRole,
  ): Promise<MembershipRecord> {
    const { getPrisma } = await import("../db/prisma.js");
    try {
      const row = await getPrisma().workspaceMember.create({
        data: { workspaceId, userId, role },
      });
      return {
        userId: row.userId,
        workspaceId: row.workspaceId,
        role: toWorkspaceRole(row.role),
        createdAt: row.createdAt,
      };
    } catch (err: unknown) {
      if (isUniqueViolation(err)) throw AppError.conflict("User is already a member");
      throw err;
    }
  }

  async createClient(workspaceId: string, input: CreateClientInput): Promise<ClientRecord> {
    const { getPrisma } = await import("../db/prisma.js");
    try {
      const row = await getPrisma().client.create({
        data: {
          workspaceId,
          name: input.name,
          email: normalizeEmail(input.email),
          ...(input.company !== undefined ? { company: input.company } : {}),
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
          ...(input.billingEmail !== undefined ? { billingEmail: input.billingEmail } : {}),
          ...(input.billingAddress !== undefined ? { billingAddress: input.billingAddress } : {}),
          ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
          ...(input.country !== undefined ? { country: input.country } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
        },
      });
      return mapClientRow(row);
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw AppError.conflict("Client email already exists in this workspace");
      }
      throw err;
    }
  }

  async listClients(workspaceId: string): Promise<ClientRecord[]> {
    const { getPrisma } = await import("../db/prisma.js");
    const rows = await getPrisma().client.findMany({
      where: { workspaceId },
      orderBy: { name: "asc" },
    });
    return rows.map(mapClientRow);
  }

  async findClient(id: string): Promise<ClientRecord | undefined> {
    const { getPrisma } = await import("../db/prisma.js");
    const row = await getPrisma().client.findUnique({ where: { id } });
    if (!row) return undefined;
    return mapClientRow(row);
  }

  async updateClient(id: string, patch: UpdateClientInput): Promise<ClientRecord> {
    const { getPrisma } = await import("../db/prisma.js");
    const row = await getPrisma().client.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.company !== undefined ? { company: patch.company ?? null } : {}),
        ...(patch.phone !== undefined ? { phone: patch.phone ?? null } : {}),
        ...(patch.billingEmail !== undefined ? { billingEmail: patch.billingEmail ?? null } : {}),
        ...(patch.billingAddress !== undefined
          ? { billingAddress: patch.billingAddress ?? null }
          : {}),
        ...(patch.timezone !== undefined ? { timezone: patch.timezone ?? null } : {}),
        ...(patch.country !== undefined ? { country: patch.country ?? null } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes ?? null } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
      },
    });
    return mapClientRow(row);
  }

  async createProject(workspaceId: string, input: CreateProjectInput): Promise<ProjectRecord> {
    const { getPrisma } = await import("../db/prisma.js");
    const prisma = getPrisma();
    const client = await prisma.client.findUnique({ where: { id: input.clientId } });
    if (!client) throw AppError.notFound("Client not found");
    if (client.workspaceId !== workspaceId) {
      throw AppError.unprocessable("Client does not belong to this workspace");
    }
    const row = await prisma.project.create({
      data: {
        workspaceId,
        clientId: input.clientId,
        title: input.title,
        ...(input.description !== undefined ? { description: input.description } : {}),
        currency: input.currency,
        totalValueCents: input.totalValueCents,
        ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
        ...(input.expectedCompletion !== undefined
          ? { expectedCompletion: input.expectedCompletion }
          : {}),
        ...(input.paymentTerms !== undefined ? { paymentTerms: input.paymentTerms } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      },
    });
    return mapProjectRow(row);
  }

  async listProjects(workspaceId: string): Promise<ProjectRecord[]> {
    const { getPrisma } = await import("../db/prisma.js");
    const rows = await getPrisma().project.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(mapProjectRow);
  }

  async findProject(id: string): Promise<ProjectRecord | undefined> {
    const { getPrisma } = await import("../db/prisma.js");
    const row = await getPrisma().project.findUnique({ where: { id } });
    if (!row) return undefined;
    return mapProjectRow(row);
  }

  async updateProject(id: string, patch: UpdateProjectInput): Promise<ProjectRecord> {
    const { getPrisma } = await import("../db/prisma.js");
    const prisma = getPrisma();
    if (patch.clientId !== undefined) {
      const existing = await prisma.project.findUnique({ where: { id } });
      if (!existing) throw AppError.notFound("Project not found");
      const client = await prisma.client.findUnique({ where: { id: patch.clientId } });
      if (!client) throw AppError.notFound("Client not found");
      if (client.workspaceId !== existing.workspaceId) {
        throw AppError.unprocessable("Client does not belong to this workspace");
      }
    }
    const row = await prisma.project.update({
      where: { id },
      data: {
        ...(patch.clientId !== undefined ? { clientId: patch.clientId } : {}),
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description ?? null } : {}),
        ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
        ...(patch.totalValueCents !== undefined ? { totalValueCents: patch.totalValueCents } : {}),
        ...(patch.startDate !== undefined ? { startDate: patch.startDate } : {}),
        ...(patch.expectedCompletion !== undefined
          ? { expectedCompletion: patch.expectedCompletion }
          : {}),
        ...(patch.paymentTerms !== undefined ? { paymentTerms: patch.paymentTerms ?? null } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.reminderPolicy !== undefined
          ? { reminderPolicy: { ...patch.reminderPolicy } as never }
          : {}),
      },
    });
    return mapProjectRow(row);
  }

  async listMilestones(projectId: string): Promise<MilestoneRecord[]> {
    const { getPrisma } = await import("../db/prisma.js");
    const rows = await getPrisma().milestone.findMany({
      where: { projectId },
      orderBy: { orderIndex: "asc" },
    });
    return rows.map(mapMilestoneRow);
  }

  async createMilestone(
    workspaceId: string,
    projectId: string,
    input: CreateMilestoneInput,
  ): Promise<MilestoneRecord> {
    const { getPrisma } = await import("../db/prisma.js");
    const prisma = getPrisma();
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw AppError.notFound("Project not found");
    if (project.workspaceId !== workspaceId) throw AppError.forbidden();
    try {
      const row = await prisma.milestone.create({
        data: {
          workspaceId,
          projectId,
          title: input.title,
          ...(input.description !== undefined ? { description: input.description } : {}),
          amountCents: input.amountCents,
          currency: (input.currency ?? project.currency).toUpperCase(),
          ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
          ...(input.workState !== undefined ? { workState: input.workState } : {}),
          ...(input.paymentState !== undefined ? { paymentState: input.paymentState } : {}),
          ...(input.approvalState !== undefined ? { approvalState: input.approvalState } : {}),
          ...(input.deliverableState !== undefined
            ? { deliverableState: input.deliverableState }
            : {}),
          ...(input.unlockState !== undefined
            ? { unlockState: input.unlockState }
            : { unlockState: input.orderIndex === 0 ? "available" : "locked" }),
          ...(input.currentVersionId !== undefined
            ? { currentVersionId: input.currentVersionId }
            : {}),
          orderIndex: input.orderIndex,
        },
      });
      return mapMilestoneRow(row);
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw AppError.conflict(`orderIndex ${input.orderIndex} is already taken`);
      }
      throw err;
    }
  }

  async findMilestone(id: string): Promise<MilestoneRecord | undefined> {
    const { getPrisma } = await import("../db/prisma.js");
    const row = await getPrisma().milestone.findUnique({ where: { id } });
    if (!row) return undefined;
    return mapMilestoneRow(row);
  }

  async updateMilestone(id: string, patch: UpdateMilestoneInput): Promise<MilestoneRecord> {
    const { getPrisma } = await import("../db/prisma.js");
    try {
      const row = await getPrisma().milestone.update({
        where: { id },
        data: {
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.description !== undefined ? { description: patch.description ?? null } : {}),
          ...(patch.amountCents !== undefined ? { amountCents: patch.amountCents } : {}),
          ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
          ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate } : {}),
          ...(patch.orderIndex !== undefined ? { orderIndex: patch.orderIndex } : {}),
          ...(patch.workState !== undefined ? { workState: patch.workState } : {}),
          ...(patch.paymentState !== undefined ? { paymentState: patch.paymentState } : {}),
          ...(patch.approvalState !== undefined ? { approvalState: patch.approvalState } : {}),
          ...(patch.deliverableState !== undefined
            ? { deliverableState: patch.deliverableState }
            : {}),
          ...(patch.unlockState !== undefined ? { unlockState: patch.unlockState } : {}),
          ...(patch.appliedPaymentIds !== undefined
            ? { appliedPaymentIds: [...patch.appliedPaymentIds] }
            : {}),
          ...(patch.amountHistory !== undefined
            ? { amountHistory: [...patch.amountHistory] as unknown as never }
            : {}),
          ...(patch.approvedVersionId !== undefined
            ? { approvedVersionId: patch.approvedVersionId ?? null }
            : {}),
          ...(patch.currentVersionId !== undefined
            ? { currentVersionId: patch.currentVersionId ?? null }
            : {}),
        },
      });
      return mapMilestoneRow(row);
    } catch (err: unknown) {
      if (isUniqueViolation(err)) throw AppError.conflict("orderIndex is already taken");
      throw err;
    }
  }

  async appendProjectEvent(
    workspaceId: string,
    projectId: string,
    input: AppendProjectEventInput,
  ): Promise<ProjectEventRecord> {
    const { getPrisma } = await import("../db/prisma.js");
    try {
      const row = await getPrisma().event.create({
        data: {
          workspaceId,
          projectId,
          ...(input.milestoneId !== undefined ? { milestoneId: input.milestoneId } : {}),
          actorType: input.actorType,
          ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
          type: input.type,
          payload: {
            ...(input.payload ?? {}),
            ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
            ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
          },
          occurredAt: input.occurredAt ?? new Date(),
          ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
        },
      });
      return {
        id: row.id,
        workspaceId: row.workspaceId,
        projectId: row.projectId,
        ...(row.milestoneId ? { milestoneId: row.milestoneId } : {}),
        type: row.type,
        actorType: row.actorType,
        occurredAt: row.occurredAt,
        payload: (row.payload ?? {}) as Record<string, unknown>,
      };
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw AppError.conflict("Event already recorded for this idempotency key");
      }
      throw err;
    }
  }

  async listPayments(projectId: string): Promise<PaymentRecord[]> {
    const { getPrisma } = await import("../db/prisma.js");
    const rows = await getPrisma().payment.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(mapPaymentRow);
  }

  async findPaymentById(id: string): Promise<PaymentRecord | undefined> {
    const { getPrisma } = await import("../db/prisma.js");
    const row = await getPrisma().payment.findUnique({ where: { id } });
    if (!row) return undefined;
    return mapPaymentRow(row);
  }

  async findPaymentByProvider(
    provider: string,
    providerPaymentId: string,
  ): Promise<PaymentRecord | undefined> {
    const { getPrisma } = await import("../db/prisma.js");
    const row = await getPrisma().payment.findUnique({
      where: { provider_providerPaymentId: { provider, providerPaymentId } },
    });
    if (!row) return undefined;
    return mapPaymentRow(row);
  }

  async findPaymentByIdempotencyKey(idempotencyKey: string): Promise<PaymentRecord | undefined> {
    const { getPrisma } = await import("../db/prisma.js");
    const row = await getPrisma().payment.findUnique({ where: { idempotencyKey } });
    if (!row) return undefined;
    return mapPaymentRow(row);
  }

  async createPayment(workspaceId: string, input: CreatePaymentInput): Promise<PaymentRecord> {
    const { getPrisma } = await import("../db/prisma.js");
    const prisma = getPrisma();
    const project = await prisma.project.findUnique({ where: { id: input.projectId } });
    if (!project) throw AppError.notFound("Project not found");
    if (project.workspaceId !== workspaceId) throw AppError.forbidden();
    try {
      const row = await prisma.payment.create({
        data: {
          ...(input.id !== undefined ? { id: input.id } : {}),
          workspaceId,
          projectId: input.projectId,
          ...(input.milestoneId !== undefined ? { milestoneId: input.milestoneId } : {}),
          provider: input.provider ?? "stripe",
          providerPaymentId: input.providerPaymentId,
          amountCents: input.amountCents,
          currency: input.currency.toUpperCase(),
          ...(input.state !== undefined ? { state: input.state as never } : {}),
          idempotencyKey: input.idempotencyKey,
          ...(input.rawWebhookRef !== undefined ? { rawWebhookRef: input.rawWebhookRef } : {}),
          ...(input.receivedAt !== undefined ? { receivedAt: input.receivedAt } : {}),
        },
      });
      return mapPaymentRow(row);
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw AppError.conflict("Payment already exists (idempotency or provider duplicate)");
      }
      throw err;
    }
  }

  async updatePaymentLifecycle(
    id: string,
    patch: UpdatePaymentLifecycleInput,
  ): Promise<PaymentRecord> {
    const { getPrisma } = await import("../db/prisma.js");
    // Lifecycle-only update: money/provider linkage is write-once per the DB
    // guard trigger — only state/receivedAt/rawWebhookRef may advance.
    const row = await getPrisma().payment.update({
      where: { id },
      data: {
        ...(patch.state !== undefined ? { state: patch.state as never } : {}),
        ...(patch.rawWebhookRef !== undefined ? { rawWebhookRef: patch.rawWebhookRef } : {}),
        ...(patch.receivedAt !== undefined ? { receivedAt: patch.receivedAt } : {}),
      },
    });
    return mapPaymentRow(row);
  }

  async listProjectEvents(projectId: string, limit = 20): Promise<ProjectEventRecord[]> {
    const { getPrisma } = await import("../db/prisma.js");
    const rows = await getPrisma().event.findMany({
      where: { projectId },
      orderBy: { occurredAt: "desc" },
      take: Math.max(1, Math.min(500, limit)),
    });
    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      ...(row.milestoneId ? { milestoneId: row.milestoneId } : {}),
      type: row.type,
      actorType: row.actorType,
      occurredAt: row.occurredAt,
      payload: (row.payload ?? {}) as Record<string, unknown>,
    }));
  }

  async findProjectEventById(id: string): Promise<ProjectEventRecord | undefined> {
    const { getPrisma } = await import("../db/prisma.js");
    const row = await getPrisma().event.findUnique({ where: { id } });
    if (!row) return undefined;
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      ...(row.milestoneId ? { milestoneId: row.milestoneId } : {}),
      type: row.type,
      actorType: row.actorType,
      occurredAt: row.occurredAt,
      payload: (row.payload ?? {}) as Record<string, unknown>,
    };
  }

  async createAgreement(
    workspaceId: string,
    projectId: string,
    input: CreateAgreementInput,
  ): Promise<AgreementRecord> {
    const { getPrisma } = await import("../db/prisma.js");
    const prisma = getPrisma();
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw AppError.notFound("Project not found");
    if (project.workspaceId !== workspaceId) throw AppError.forbidden();
    try {
      const row = await prisma.agreement.create({
        data: {
          workspaceId,
          projectId,
          version: input.version,
          ...(input.status !== undefined ? { status: input.status } : {}),
          isCurrent: true,
          termsText: input.termsText,
          paymentDueDays: input.paymentDueDays,
          graceDays: input.graceDays,
          pauseAfterOverdueDays: input.pauseAfterOverdueDays,
          releaseCondition: input.releaseCondition as never,
          lateFeePolicy:
            typeof input.latePaymentPolicy.description === "string"
              ? input.latePaymentPolicy.description
              : null,
          totalAmountCents: input.totalAmountCents,
          currency: input.currency,
          depositAmountCents: input.depositAmountCents,
          milestoneSchedule: input.milestoneSchedule.map((m) => ({ ...m })) as never,
          paymentMethods: [...input.acceptedPaymentMethods],
          latePaymentPolicy: { ...input.latePaymentPolicy } as never,
          workPauseDescription: input.workPauseDescription,
          finalDeliveryDescription: input.finalDeliveryDescription,
          ownershipMode: input.ownershipMode,
          ownershipDescription: input.ownershipDescription,
          maxRevisionsPerMilestone: input.maxRevisionsPerMilestone,
          extraRevisionPolicy: input.extraRevisionPolicy,
          cancellationNoticeDays: input.cancellationNoticeDays,
          ...(input.cancellationKillFeeCents !== undefined
            ? { cancellationKillFeeCents: input.cancellationKillFeeCents }
            : {}),
          cancellationPolicy: input.cancellationPolicy,
          ...(input.customClauses !== undefined ? { customClauses: input.customClauses } : {}),
          disclaimerVersion: input.disclaimerVersion,
          hash: input.hash,
          ...(input.supersedesId !== undefined ? { supersedesId: input.supersedesId } : {}),
        },
      });
      return mapAgreementRow(row);
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw AppError.conflict(`Agreement version ${input.version} already exists`);
      }
      throw err;
    }
  }

  async listAgreements(projectId: string): Promise<AgreementRecord[]> {
    const { getPrisma } = await import("../db/prisma.js");
    const rows = await getPrisma().agreement.findMany({
      where: { projectId },
      orderBy: { version: "asc" },
    });
    return rows.map((row) => mapAgreementRow(row));
  }

  async findAgreement(id: string): Promise<AgreementRecord | undefined> {
    const { getPrisma } = await import("../db/prisma.js");
    const row = await getPrisma().agreement.findUnique({ where: { id } });
    if (!row) return undefined;
    return mapAgreementRow(row);
  }

  async findAgreementByVersion(
    projectId: string,
    version: number,
  ): Promise<AgreementRecord | undefined> {
    const { getPrisma } = await import("../db/prisma.js");
    const row = await getPrisma().agreement.findUnique({
      where: { projectId_version: { projectId, version } },
    });
    if (!row) return undefined;
    return mapAgreementRow(row);
  }

  async updateAgreementLifecycle(
    id: string,
    patch: UpdateAgreementLifecycleInput,
  ): Promise<AgreementRecord> {
    const { getPrisma } = await import("../db/prisma.js");
    const row = await getPrisma().agreement.update({
      where: { id },
      data: {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.isCurrent !== undefined ? { isCurrent: patch.isCurrent } : {}),
        ...(patch.sentAt !== undefined ? { sentAt: patch.sentAt } : {}),
        ...(patch.acceptedAt !== undefined ? { acceptedAt: patch.acceptedAt } : {}),
        ...(patch.acceptedBy !== undefined ? { acceptedBy: patch.acceptedBy } : {}),
        ...(patch.acceptIpHash !== undefined ? { acceptIpHash: patch.acceptIpHash } : {}),
        ...(patch.acceptUaHash !== undefined ? { acceptUaHash: patch.acceptUaHash } : {}),
        ...(patch.voidedAt !== undefined ? { voidedAt: patch.voidedAt } : {}),
      },
    });
    return mapAgreementRow(row);
  }

  async createPortalLink(
    workspaceId: string,
    projectId: string,
    input: CreatePortalLinkInput,
  ): Promise<PortalLinkRecord> {
    const { getPrisma } = await import("../db/prisma.js");
    const prisma = getPrisma();
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw AppError.notFound("Project not found");
    if (project.workspaceId !== workspaceId) throw AppError.forbidden();
    try {
      const row = await prisma.portalLink.create({
        data: {
          workspaceId,
          projectId,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
        },
      });
      return mapPortalLinkRow(row);
    } catch (err: unknown) {
      if (isUniqueViolation(err)) throw AppError.conflict("Portal link already exists");
      throw err;
    }
  }

  async listPortalLinks(projectId: string): Promise<PortalLinkRecord[]> {
    const { getPrisma } = await import("../db/prisma.js");
    const rows = await getPrisma().portalLink.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(mapPortalLinkRow);
  }

  async findPortalLinkById(id: string): Promise<PortalLinkRecord | undefined> {
    const { getPrisma } = await import("../db/prisma.js");
    const row = await getPrisma().portalLink.findUnique({ where: { id } });
    if (!row) return undefined;
    return mapPortalLinkRow(row);
  }

  async findPortalLinkByTokenHash(tokenHash: string): Promise<PortalLinkRecord | undefined> {
    const { getPrisma } = await import("../db/prisma.js");
    const row = await getPrisma().portalLink.findUnique({ where: { tokenHash } });
    if (!row) return undefined;
    return mapPortalLinkRow(row);
  }

  async revokePortalLink(id: string): Promise<PortalLinkRecord> {
    const { getPrisma } = await import("../db/prisma.js");
    const row = await getPrisma().portalLink.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
    return mapPortalLinkRow(row);
  }

  async createDeliverable(
    workspaceId: string,
    input: CreateDeliverableInput,
  ): Promise<DeliverableRecord> {
    const { getPrisma } = await import("../db/prisma.js");
    const prisma = getPrisma();
    const project = await prisma.project.findUnique({ where: { id: input.projectId } });
    if (!project) throw AppError.notFound("Project not found");
    if (project.workspaceId !== workspaceId) throw AppError.forbidden();
    const milestone = await prisma.milestone.findUnique({ where: { id: input.milestoneId } });
    if (milestone?.projectId !== input.projectId) {
      throw AppError.notFound("Milestone not found");
    }
    const row = await prisma.deliverable.create({
      data: {
        workspaceId,
        projectId: input.projectId,
        milestoneId: input.milestoneId,
        title: input.title.trim(),
        ...(input.description !== undefined ? { description: input.description } : {}),
        status: "draft",
        deliveryState: "locked",
        stagingTransferState: "none",
        currentVersionNo: 0,
      },
    });
    return mapDeliverableRow(row);
  }

  async listDeliverablesByMilestone(milestoneId: string): Promise<DeliverableRecord[]> {
    const { getPrisma } = await import("../db/prisma.js");
    const rows = await getPrisma().deliverable.findMany({
      where: { milestoneId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((row) => mapDeliverableRow(row));
  }

  async listDeliverablesByProject(projectId: string): Promise<DeliverableRecord[]> {
    const { getPrisma } = await import("../db/prisma.js");
    const rows = await getPrisma().deliverable.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((row) => mapDeliverableRow(row));
  }

  async findDeliverable(id: string): Promise<DeliverableRecord | undefined> {
    const { getPrisma } = await import("../db/prisma.js");
    const row = await getPrisma().deliverable.findUnique({ where: { id } });
    if (!row) return undefined;
    return mapDeliverableRow(row);
  }

  async updateDeliverable(id: string, patch: UpdateDeliverableInput): Promise<DeliverableRecord> {
    const { getPrisma } = await import("../db/prisma.js");
    const row = await getPrisma().deliverable.update({
      where: { id },
      data: {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.deliveryState !== undefined ? { deliveryState: patch.deliveryState } : {}),
        ...(patch.stagingUrl !== undefined ? { stagingUrl: patch.stagingUrl } : {}),
        ...(patch.stagingTransferState !== undefined
          ? { stagingTransferState: patch.stagingTransferState }
          : {}),
        ...(patch.currentVersionNo !== undefined
          ? { currentVersionNo: patch.currentVersionNo }
          : {}),
        ...(patch.approvedVersionNo !== undefined
          ? { approvedVersionNo: patch.approvedVersionNo }
          : {}),
      },
    });
    return mapDeliverableRow(row);
  }

  async createDeliverableVersion(
    deliverableId: string,
    input: CreateDeliverableVersionInput,
  ): Promise<DeliverableVersionRecord> {
    const { getPrisma } = await import("../db/prisma.js");
    const prisma = getPrisma();
    const deliverable = await prisma.deliverable.findUnique({ where: { id: deliverableId } });
    if (!deliverable) throw AppError.notFound("Deliverable not found");
    const versionNo = deliverable.currentVersionNo + 1;
    try {
      const row = await prisma.deliverableVersion.create({
        data: {
          deliverableId,
          versionNo,
          ...(input.description !== undefined ? { description: input.description } : {}),
          files: input.files.map((f) => ({ ...f })) as unknown as never,
          links: [...input.links],
          ...(input.previewText !== undefined ? { previewText: input.previewText } : {}),
          ...(input.stagingUrl !== undefined ? { stagingUrl: input.stagingUrl } : {}),
          ...(input.previewArtifactRef !== undefined
            ? { previewArtifactRef: input.previewArtifactRef }
            : {}),
          ...(input.finalArtifactRef !== undefined
            ? { finalArtifactRef: input.finalArtifactRef }
            : {}),
          createdBy: input.createdBy,
        },
      });
      await prisma.deliverable.update({
        where: { id: deliverableId },
        data: { currentVersionNo: versionNo },
      });
      return mapDeliverableVersionRow(row);
    } catch (err: unknown) {
      if (isUniqueViolation(err)) throw AppError.conflict(`Version ${versionNo} already exists`);
      throw err;
    }
  }

  async listDeliverableVersions(deliverableId: string): Promise<DeliverableVersionRecord[]> {
    const { getPrisma } = await import("../db/prisma.js");
    const rows = await getPrisma().deliverableVersion.findMany({
      where: { deliverableId },
      orderBy: { versionNo: "asc" },
    });
    return rows.map((row) => mapDeliverableVersionRow(row));
  }

  async findDeliverableVersion(
    deliverableId: string,
    versionNo: number,
  ): Promise<DeliverableVersionRecord | undefined> {
    const { getPrisma } = await import("../db/prisma.js");
    const row = await getPrisma().deliverableVersion.findUnique({
      where: { deliverableId_versionNo: { deliverableId, versionNo } },
    });
    if (!row) return undefined;
    return mapDeliverableVersionRow(row);
  }

  async createApproval(workspaceId: string, input: CreateApprovalInput): Promise<ApprovalRecord> {
    const { getPrisma } = await import("../db/prisma.js");
    const prisma = getPrisma();
    const project = await prisma.project.findUnique({ where: { id: input.projectId } });
    if (!project) throw AppError.notFound("Project not found");
    if (project.workspaceId !== workspaceId) throw AppError.forbidden();
    const milestone = await prisma.milestone.findUnique({ where: { id: input.milestoneId } });
    if (milestone?.projectId !== input.projectId) throw AppError.notFound("Milestone not found");
    const row = await prisma.approval.create({
      data: {
        workspaceId,
        projectId: input.projectId,
        milestoneId: input.milestoneId,
        ...(input.deliverableId !== undefined ? { deliverableId: input.deliverableId } : {}),
        ...(input.deliverableVersionId !== undefined
          ? { deliverableVersionId: input.deliverableVersionId }
          : {}),
        ...(input.versionNo !== undefined ? { versionNo: input.versionNo } : {}),
        ...(input.versionRef !== undefined ? { versionRef: input.versionRef } : {}),
        decision: input.decision,
        approverRef: input.approverRef,
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.actorType !== undefined ? { actorType: input.actorType } : {}),
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        ...(input.ipHash !== undefined ? { ipHash: input.ipHash } : {}),
        ...(input.uaHash !== undefined ? { uaHash: input.uaHash } : {}),
      },
    });
    return mapApprovalRow(row);
  }

  async listApprovalsByDeliverable(deliverableId: string): Promise<ApprovalRecord[]> {
    const { getPrisma } = await import("../db/prisma.js");
    const rows = await getPrisma().approval.findMany({
      where: { deliverableId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((row) => mapApprovalRow(row));
  }

  async listApprovalsByMilestone(milestoneId: string): Promise<ApprovalRecord[]> {
    const { getPrisma } = await import("../db/prisma.js");
    const rows = await getPrisma().approval.findMany({
      where: { milestoneId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((row) => mapApprovalRow(row));
  }

  async listApprovalsByProject(projectId: string): Promise<ApprovalRecord[]> {
    const { getPrisma } = await import("../db/prisma.js");
    const rows = await getPrisma().approval.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((row) => mapApprovalRow(row));
  }

  async createNotification(
    workspaceId: string,
    input: CreateNotificationInput,
  ): Promise<NotificationRecord> {
    const { getPrisma } = await import("../db/prisma.js");
    const prisma = getPrisma();
    if (input.projectId !== undefined) {
      const project = await prisma.project.findUnique({ where: { id: input.projectId } });
      if (!project) throw AppError.notFound("Project not found");
      if (project.workspaceId !== workspaceId) throw AppError.forbidden();
    }
    try {
      const row = await prisma.notification.create({
        data: {
          workspaceId,
          ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
          ...(input.milestoneId !== undefined ? { milestoneId: input.milestoneId } : {}),
          ...(input.channel !== undefined ? { channel: input.channel as never } : {}),
          template: input.template,
          ...(input.templateVersion !== undefined
            ? { templateVersion: input.templateVersion }
            : {}),
          ...(input.subject !== undefined ? { subject: input.subject } : {}),
          ...(input.bodySnapshot !== undefined ? { bodySnapshot: input.bodySnapshot } : {}),
          toRef: input.recipient,
          ...(input.recipientName !== undefined ? { recipientName: input.recipientName } : {}),
          scheduledFor: input.scheduledFor,
          ...(input.nextActionAt !== undefined ? { nextActionAt: input.nextActionAt } : {}),
          ...(input.nextActionLabel !== undefined
            ? { nextActionLabel: input.nextActionLabel }
            : {}),
          ...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
          ...(input.policyStep !== undefined ? { policyStep: input.policyStep } : {}),
          ...(input.policyVersion !== undefined ? { policyVersion: input.policyVersion } : {}),
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
          ...(input.category !== undefined ? { category: input.category } : {}),
          ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
        },
      });
      return mapNotificationRow(row);
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw AppError.conflict("Reminder already scheduled for this idempotency key");
      }
      throw err;
    }
  }

  async findNotificationById(id: string): Promise<NotificationRecord | undefined> {
    const { getPrisma } = await import("../db/prisma.js");
    const row = await getPrisma().notification.findUnique({ where: { id } });
    if (!row) return undefined;
    return mapNotificationRow(row);
  }

  async findNotificationByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<NotificationRecord | undefined> {
    const { getPrisma } = await import("../db/prisma.js");
    const row = await getPrisma().notification.findUnique({ where: { idempotencyKey } });
    if (!row) return undefined;
    return mapNotificationRow(row);
  }

  async listNotificationsByMilestone(milestoneId: string): Promise<NotificationRecord[]> {
    const { getPrisma } = await import("../db/prisma.js");
    const rows = await getPrisma().notification.findMany({
      where: { milestoneId },
      orderBy: { scheduledFor: "asc" },
    });
    return rows.map((row) => mapNotificationRow(row));
  }

  async listNotificationsByProject(projectId: string): Promise<NotificationRecord[]> {
    const { getPrisma } = await import("../db/prisma.js");
    const rows = await getPrisma().notification.findMany({
      where: { projectId },
      orderBy: { scheduledFor: "asc" },
    });
    return rows.map((row) => mapNotificationRow(row));
  }

  async updateNotification(
    id: string,
    patch: UpdateNotificationInput,
  ): Promise<NotificationRecord> {
    const { getPrisma } = await import("../db/prisma.js");
    const row = await getPrisma().notification.update({
      where: { id },
      data: {
        ...(patch.state !== undefined ? { state: patch.state as never } : {}),
        ...(patch.providerMessageId !== undefined
          ? { providerMsgId: patch.providerMessageId ?? null }
          : {}),
        ...(patch.sentAt !== undefined ? { sentAt: patch.sentAt } : {}),
        ...(patch.deliveredAt !== undefined ? { deliveredAt: patch.deliveredAt } : {}),
        ...(patch.canceledAt !== undefined ? { canceledAt: patch.canceledAt } : {}),
        ...(patch.attemptCount !== undefined ? { attemptCount: patch.attemptCount } : {}),
        ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
        ...(patch.nextActionAt !== undefined ? { nextActionAt: patch.nextActionAt } : {}),
        ...(patch.nextActionLabel !== undefined ? { nextActionLabel: patch.nextActionLabel } : {}),
        ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
        ...(patch.bodySnapshot !== undefined ? { bodySnapshot: patch.bodySnapshot } : {}),
        ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
        ...(patch.category !== undefined ? { category: patch.category } : {}),
        ...(patch.readAt !== undefined ? { readAt: patch.readAt } : {}),
      },
    });
    return mapNotificationRow(row);
  }

  async listWorkspaceNotifications(
    workspaceId: string,
    limit = 100,
  ): Promise<NotificationRecord[]> {
    const { getPrisma } = await import("../db/prisma.js");
    const rows = await getPrisma().notification.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      take: Math.max(1, Math.min(200, limit)),
    });
    return rows.map((row) => mapNotificationRow(row));
  }

  async listInAppForUser(workspaceId: string, userId: string): Promise<NotificationRecord[]> {
    const { getPrisma } = await import("../db/prisma.js");
    const rows = await getPrisma().notification.findMany({
      where: { workspaceId, channel: "inapp", toRef: userId },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return rows.map((row) => mapNotificationRow(row));
  }

  async getNotificationPreferences(
    workspaceId: string,
    userId: string,
  ): Promise<NotificationPreferenceRecord[]> {
    const { getPrisma } = await import("../db/prisma.js");
    const rows = await getPrisma().notificationPreference.findMany({
      where: { workspaceId, userId },
      orderBy: [{ category: "asc" }, { channel: "asc" }],
    });
    return rows.map((row) => ({
      workspaceId: row.workspaceId,
      userId: row.userId,
      category: row.category,
      channel: row.channel,
      enabled: row.enabled,
      updatedAt: row.updatedAt,
    }));
  }

  async setNotificationPreference(
    workspaceId: string,
    userId: string,
    category: string,
    channel: string,
    enabled: boolean,
  ): Promise<NotificationPreferenceRecord> {
    const { getPrisma } = await import("../db/prisma.js");
    const row = await getPrisma().notificationPreference.upsert({
      where: {
        workspaceId_userId_category_channel: {
          workspaceId,
          userId,
          category,
          channel: channel as never,
        },
      },
      create: { workspaceId, userId, category, channel: channel as never, enabled },
      update: { enabled },
    });
    return {
      workspaceId: row.workspaceId,
      userId: row.userId,
      category: row.category,
      channel: row.channel,
      enabled: row.enabled,
      updatedAt: row.updatedAt,
    };
  }

  async findNotificationOptOut(
    workspaceId: string,
    email: string,
    category: string,
  ): Promise<NotificationOptOutRecord | undefined> {
    const { getPrisma } = await import("../db/prisma.js");
    const normalized = normalizeEmail(email);
    const exact = await getPrisma().notificationOptOut.findUnique({
      where: { workspaceId_email_category: { workspaceId, email: normalized, category } },
    });
    if (exact) {
      return {
        id: exact.id,
        workspaceId: exact.workspaceId,
        email: exact.email,
        category: exact.category,
        createdAt: exact.createdAt,
      };
    }
    if (category !== "all") {
      const all = await getPrisma().notificationOptOut.findUnique({
        where: { workspaceId_email_category: { workspaceId, email: normalized, category: "all" } },
      });
      if (all) {
        return {
          id: all.id,
          workspaceId: all.workspaceId,
          email: all.email,
          category: all.category,
          createdAt: all.createdAt,
        };
      }
    }
    return undefined;
  }

  async addNotificationOptOut(
    workspaceId: string,
    email: string,
    category: string,
  ): Promise<NotificationOptOutRecord> {
    const { getPrisma } = await import("../db/prisma.js");
    const normalized = normalizeEmail(email);
    const row = await getPrisma().notificationOptOut.upsert({
      where: { workspaceId_email_category: { workspaceId, email: normalized, category } },
      create: { workspaceId, email: normalized, category },
      update: {},
    });
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      email: row.email,
      category: row.category,
      createdAt: row.createdAt,
    };
  }

  async removeNotificationOptOut(
    workspaceId: string,
    email: string,
    category: string,
  ): Promise<void> {
    const { getPrisma } = await import("../db/prisma.js");
    await getPrisma().notificationOptOut.deleteMany({
      where: { workspaceId, email: normalizeEmail(email), category },
    });
  }

  async listNotificationOptOuts(workspaceId: string): Promise<NotificationOptOutRecord[]> {
    const { getPrisma } = await import("../db/prisma.js");
    const rows = await getPrisma().notificationOptOut.findMany({
      where: { workspaceId },
      orderBy: { email: "asc" },
    });
    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      email: row.email,
      category: row.category,
      createdAt: row.createdAt,
    }));
  }

  async createPaymentPlan(
    workspaceId: string,
    input: CreatePaymentPlanInput,
  ): Promise<PaymentPlanRecord> {
    const { getPrisma } = await import("../db/prisma.js");
    const prisma = getPrisma();
    const project = await prisma.project.findUnique({ where: { id: input.projectId } });
    if (!project) throw AppError.notFound("Project not found");
    if (project.workspaceId !== workspaceId) throw AppError.forbidden();
    const milestone = await prisma.milestone.findUnique({ where: { id: input.milestoneId } });
    if (milestone?.projectId !== input.projectId) throw AppError.notFound("Milestone not found");
    const row = await prisma.paymentPlan.create({
      data: {
        workspaceId,
        projectId: input.projectId,
        milestoneId: input.milestoneId,
        originalAmountCents: input.originalAmountCents,
        currency: (input.currency ?? milestone.currency).toUpperCase(),
        installments: input.installments.map((i) => ({
          ...i,
          dueDate: i.dueDate.toISOString(),
          ...(i.paidAt !== undefined ? { paidAt: i.paidAt.toISOString() } : {}),
        })) as unknown as never,
        ...(input.version !== undefined ? { version: input.version } : {}),
        ...(input.supersedesId !== undefined ? { supersedesId: input.supersedesId } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
      },
    });
    return mapPaymentPlanRow(row);
  }

  async findPaymentPlan(id: string): Promise<PaymentPlanRecord | undefined> {
    const { getPrisma } = await import("../db/prisma.js");
    const row = await getPrisma().paymentPlan.findUnique({ where: { id } });
    if (!row) return undefined;
    return mapPaymentPlanRow(row);
  }

  async listPaymentPlansByMilestone(milestoneId: string): Promise<PaymentPlanRecord[]> {
    const { getPrisma } = await import("../db/prisma.js");
    const rows = await getPrisma().paymentPlan.findMany({
      where: { milestoneId },
      orderBy: { version: "asc" },
    });
    return rows.map((row) => mapPaymentPlanRow(row));
  }

  async listPaymentPlansByProject(projectId: string): Promise<PaymentPlanRecord[]> {
    const { getPrisma } = await import("../db/prisma.js");
    const rows = await getPrisma().paymentPlan.findMany({
      where: { projectId },
      orderBy: { version: "asc" },
    });
    return rows.map((row) => mapPaymentPlanRow(row));
  }

  async updatePaymentPlan(id: string, patch: UpdatePaymentPlanInput): Promise<PaymentPlanRecord> {
    const { getPrisma } = await import("../db/prisma.js");
    // Lifecycle-only update: the original obligation, currency, version and
    // lineage are write-once — modified schedules are new rows.
    const row = await getPrisma().paymentPlan.update({
      where: { id },
      data: {
        ...(patch.state !== undefined ? { state: patch.state as never } : {}),
        ...(patch.installments !== undefined
          ? {
              installments: patch.installments.map((i) => ({
                ...i,
                dueDate: i.dueDate.toISOString(),
                ...(i.paidAt !== undefined ? { paidAt: i.paidAt.toISOString() } : {}),
              })) as unknown as never,
            }
          : {}),
        ...(patch.acceptedAt !== undefined ? { acceptedAt: patch.acceptedAt } : {}),
        ...(patch.note !== undefined ? { note: patch.note } : {}),
      },
    });
    return mapPaymentPlanRow(row);
  }

  async createEvidencePack(
    workspaceId: string,
    input: CreateEvidencePackInput,
  ): Promise<EvidencePackRecord> {
    const { getPrisma } = await import("../db/prisma.js");
    const prisma = getPrisma();
    const project = await prisma.project.findUnique({ where: { id: input.projectId } });
    if (!project) throw AppError.notFound("Project not found");
    if (project.workspaceId !== workspaceId) throw AppError.forbidden();
    const row = await prisma.evidencePack.create({
      data: {
        workspaceId,
        projectId: input.projectId,
        generatedBy: input.generatedBy,
        ...(input.generatedAt ? { generatedAt: input.generatedAt } : {}),
        agreementVersionHashes: [...input.agreementVersionHashes],
        eventSeqFrom: BigInt(input.eventSeqFrom),
        eventSeqTo: BigInt(input.eventSeqTo),
        artifactRef: input.artifactRef,
        sha256: input.sha256,
        ...(input.disclaimerVersion !== undefined
          ? { disclaimerVersion: input.disclaimerVersion }
          : {}),
      },
    });
    return mapEvidencePackRow(row);
  }

  async listEvidencePacksByProject(projectId: string): Promise<EvidencePackRecord[]> {
    const { getPrisma } = await import("../db/prisma.js");
    const rows = await getPrisma().evidencePack.findMany({
      where: { projectId },
      orderBy: { generatedAt: "desc" },
    });
    return rows.map((row) => mapEvidencePackRow(row));
  }

  async findEvidencePack(id: string): Promise<EvidencePackRecord | undefined> {
    const { getPrisma } = await import("../db/prisma.js");
    const row = await getPrisma().evidencePack.findUnique({ where: { id } });
    if (!row) return undefined;
    return mapEvidencePackRow(row);
  }
}

interface MilestoneRow {
  id: string;
  workspaceId: string;
  projectId: string;
  title: string;
  description: string | null;
  amountCents: number;
  currency: string;
  dueDate: Date | null;
  workState: string;
  paymentState: string;
  approvalState: string;
  deliverableState: string;
  unlockState: string;
  appliedPaymentIds: string[];
  amountHistory: unknown;
  approvedVersionId: string | null;
  currentVersionId: string | null;
  orderIndex: number;
  createdAt: Date;
  updatedAt: Date;
}

function mapMilestoneRow(row: MilestoneRow): MilestoneRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    title: row.title,
    ...(row.description ? { description: row.description } : {}),
    amountCents: row.amountCents,
    currency: row.currency,
    ...(row.dueDate ? { dueDate: row.dueDate } : {}),
    workState: row.workState,
    paymentState: row.paymentState,
    approvalState: row.approvalState,
    deliverableState: row.deliverableState,
    unlockState: row.unlockState,
    appliedPaymentIds: [...row.appliedPaymentIds],
    amountHistory: Array.isArray(row.amountHistory)
      ? (row.amountHistory as Record<string, unknown>[])
      : [],
    ...(row.approvedVersionId ? { approvedVersionId: row.approvedVersionId } : {}),
    ...(row.currentVersionId ? { currentVersionId: row.currentVersionId } : {}),
    orderIndex: row.orderIndex,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

interface ClientRow {
  id: string;
  workspaceId: string;
  name: string;
  email: string;
  company: string | null;
  phone: string | null;
  billingEmail: string | null;
  billingAddress: string | null;
  timezone: string | null;
  country: string | null;
  notes: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

interface ProjectRow {
  id: string;
  workspaceId: string;
  clientId: string;
  title: string;
  description: string | null;
  currency: string;
  totalValueCents: number;
  startDate: Date | null;
  expectedCompletion: Date | null;
  paymentTerms: string | null;
  status: string;
  reminderPolicy: unknown;
  createdAt: Date;
  updatedAt: Date;
}

function mapClientRow(row: ClientRow): ClientRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    email: row.email,
    ...(row.company ? { company: row.company } : {}),
    ...(row.phone ? { phone: row.phone } : {}),
    ...(row.billingEmail ? { billingEmail: row.billingEmail } : {}),
    ...(row.billingAddress ? { billingAddress: row.billingAddress } : {}),
    ...(row.timezone ? { timezone: row.timezone } : {}),
    ...(row.country ? { country: row.country } : {}),
    ...(row.notes ? { notes: row.notes } : {}),
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapProjectRow(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    clientId: row.clientId,
    title: row.title,
    ...(row.description ? { description: row.description } : {}),
    currency: row.currency,
    totalValueCents: row.totalValueCents,
    ...(row.startDate ? { startDate: row.startDate } : {}),
    ...(row.expectedCompletion ? { expectedCompletion: row.expectedCompletion } : {}),
    ...(row.paymentTerms ? { paymentTerms: row.paymentTerms } : {}),
    status: row.status,
    reminderPolicy: parseReminderDefaults(row.reminderPolicy),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseReminderDefaults(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  return {};
}

interface AgreementRow {
  id: string;
  workspaceId: string;
  projectId: string;
  version: number;
  status: string;
  isCurrent: boolean;
  totalAmountCents: number | null;
  currency: string;
  depositAmountCents: number | null;
  milestoneSchedule: unknown;
  paymentDueDays: number;
  graceDays: number;
  pauseAfterOverdueDays: number;
  paymentMethods: string[];
  latePaymentPolicy: unknown;
  workPauseDescription: string | null;
  finalDeliveryDescription: string | null;
  releaseCondition: string;
  ownershipMode: string | null;
  ownershipDescription: string | null;
  maxRevisionsPerMilestone: number | null;
  extraRevisionPolicy: string | null;
  cancellationNoticeDays: number | null;
  cancellationKillFeeCents: number | null;
  cancellationPolicy: string | null;
  customClauses: string | null;
  termsText: string;
  hash: string;
  disclaimerVersion: string;
  supersedesId: string | null;
  sentAt: Date | null;
  acceptedAt: Date | null;
  acceptedBy: string | null;
  acceptIpHash: string | null;
  acceptUaHash: string | null;
  voidedAt: Date | null;
  createdAt: Date;
}

function parseSchedule(value: unknown): AgreementRecord["milestoneSchedule"] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
    .map((v) => ({
      title: typeof v.title === "string" ? v.title : "",
      amountCents: typeof v.amountCents === "number" ? v.amountCents : 0,
      ...(typeof v.dueLabel === "string" ? { dueLabel: v.dueLabel } : {}),
    }));
}

function mapAgreementRow(row: AgreementRow): AgreementRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    version: row.version,
    status: row.status,
    isCurrent: row.isCurrent,
    totalAmountCents: row.totalAmountCents ?? 0,
    currency: row.currency,
    depositAmountCents: row.depositAmountCents ?? 0,
    milestoneSchedule: parseSchedule(row.milestoneSchedule),
    paymentDueDays: row.paymentDueDays,
    graceDays: row.graceDays,
    pauseAfterOverdueDays: row.pauseAfterOverdueDays,
    acceptedPaymentMethods: [...row.paymentMethods],
    latePaymentPolicy:
      typeof row.latePaymentPolicy === "object" && row.latePaymentPolicy !== null
        ? { ...(row.latePaymentPolicy as Record<string, unknown>) }
        : {},
    workPauseDescription: row.workPauseDescription ?? "",
    releaseCondition: row.releaseCondition,
    finalDeliveryDescription: row.finalDeliveryDescription ?? "",
    ownershipMode: row.ownershipMode ?? "",
    ownershipDescription: row.ownershipDescription ?? "",
    maxRevisionsPerMilestone: row.maxRevisionsPerMilestone ?? 0,
    extraRevisionPolicy: row.extraRevisionPolicy ?? "",
    cancellationNoticeDays: row.cancellationNoticeDays ?? 0,
    ...(row.cancellationKillFeeCents !== null
      ? { cancellationKillFeeCents: row.cancellationKillFeeCents }
      : {}),
    cancellationPolicy: row.cancellationPolicy ?? "",
    ...(row.customClauses ? { customClauses: row.customClauses } : {}),
    termsText: row.termsText,
    hash: row.hash,
    disclaimerVersion: row.disclaimerVersion,
    ...(row.supersedesId ? { supersedesId: row.supersedesId } : {}),
    ...(row.sentAt ? { sentAt: row.sentAt } : {}),
    ...(row.acceptedAt ? { acceptedAt: row.acceptedAt } : {}),
    ...(row.acceptedBy ? { acceptedBy: row.acceptedBy } : {}),
    ...(row.acceptIpHash ? { acceptIpHash: row.acceptIpHash } : {}),
    ...(row.acceptUaHash ? { acceptUaHash: row.acceptUaHash } : {}),
    ...(row.voidedAt ? { voidedAt: row.voidedAt } : {}),
    createdAt: row.createdAt,
  };
}

interface PortalLinkRow {
  id: string;
  workspaceId: string;
  projectId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

function mapPortalLinkRow(row: PortalLinkRow): PortalLinkRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    tokenHash: row.tokenHash,
    expiresAt: row.expiresAt,
    ...(row.revokedAt ? { revokedAt: row.revokedAt } : {}),
    createdAt: row.createdAt,
  };
}

interface PaymentRow {
  id: string;
  workspaceId: string;
  projectId: string;
  milestoneId: string | null;
  provider: string;
  providerPaymentId: string;
  amountCents: number;
  currency: string;
  state: string;
  idempotencyKey: string;
  rawWebhookRef: string | null;
  receivedAt: Date | null;
  createdAt: Date;
}

function mapPaymentRow(row: PaymentRow): PaymentRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    ...(row.milestoneId ? { milestoneId: row.milestoneId } : {}),
    provider: row.provider,
    providerPaymentId: row.providerPaymentId,
    amountCents: row.amountCents,
    currency: row.currency,
    state: row.state,
    idempotencyKey: row.idempotencyKey,
    ...(row.rawWebhookRef ? { rawWebhookRef: row.rawWebhookRef } : {}),
    ...(row.receivedAt ? { receivedAt: row.receivedAt } : {}),
    createdAt: row.createdAt,
  };
}

interface DeliverableRow {
  id: string;
  workspaceId: string;
  projectId: string;
  milestoneId: string;
  title: string;
  description: string | null;
  status: string;
  deliveryState: string;
  stagingUrl: string | null;
  stagingTransferState: string;
  currentVersionNo: number;
  approvedVersionNo: number | null;
  createdAt: Date;
  updatedAt: Date;
}

function mapDeliverableRow(row: DeliverableRow): DeliverableRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    milestoneId: row.milestoneId,
    title: row.title,
    ...(row.description ? { description: row.description } : {}),
    status: row.status,
    deliveryState: row.deliveryState,
    ...(row.stagingUrl ? { stagingUrl: row.stagingUrl } : {}),
    stagingTransferState: row.stagingTransferState,
    currentVersionNo: row.currentVersionNo,
    ...(row.approvedVersionNo !== null ? { approvedVersionNo: row.approvedVersionNo } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

interface DeliverableVersionRow {
  id: string;
  deliverableId: string;
  versionNo: number;
  description: string | null;
  files: unknown;
  links: string[];
  previewText: string | null;
  stagingUrl: string | null;
  previewArtifactRef: string | null;
  finalArtifactRef: string | null;
  createdBy: string;
  createdAt: Date;
}

function parseDeliverableFiles(value: unknown): DeliverableFileEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
    .filter(
      (v) =>
        typeof v.key === "string" &&
        typeof v.filename === "string" &&
        typeof v.contentType === "string" &&
        typeof v.sizeBytes === "number" &&
        (v.visibility === "review" || v.visibility === "final"),
    )
    .map((v) => ({
      key: v.key as string,
      filename: v.filename as string,
      contentType: v.contentType as string,
      sizeBytes: v.sizeBytes as number,
      ...(typeof v.sha256 === "string" ? { sha256: v.sha256 } : {}),
      visibility: v.visibility as "review" | "final",
    }));
}

function mapDeliverableVersionRow(row: DeliverableVersionRow): DeliverableVersionRecord {
  return {
    id: row.id,
    deliverableId: row.deliverableId,
    versionNo: row.versionNo,
    ...(row.description ? { description: row.description } : {}),
    files: parseDeliverableFiles(row.files),
    links: [...row.links],
    ...(row.previewText ? { previewText: row.previewText } : {}),
    ...(row.stagingUrl ? { stagingUrl: row.stagingUrl } : {}),
    ...(row.previewArtifactRef ? { previewArtifactRef: row.previewArtifactRef } : {}),
    ...(row.finalArtifactRef ? { finalArtifactRef: row.finalArtifactRef } : {}),
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

interface ApprovalRow {
  id: string;
  workspaceId: string;
  projectId: string;
  milestoneId: string;
  deliverableId: string | null;
  deliverableVersionId: string | null;
  versionNo: number | null;
  versionRef: string | null;
  decision: string;
  approverRef: string;
  note: string | null;
  actorType: string;
  actorId: string | null;
  ipHash: string | null;
  uaHash: string | null;
  createdAt: Date;
}

function toApprovalDecision(value: string): ApprovalRecord["decision"] {
  if (
    value === "approved" ||
    value === "revision_requested" ||
    value === "rejected" ||
    value === "disputed"
  ) {
    return value;
  }
  throw AppError.internal("Unknown approval decision");
}

function mapApprovalRow(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    milestoneId: row.milestoneId,
    ...(row.deliverableId ? { deliverableId: row.deliverableId } : {}),
    ...(row.deliverableVersionId ? { deliverableVersionId: row.deliverableVersionId } : {}),
    ...(row.versionNo !== null ? { versionNo: row.versionNo } : {}),
    ...(row.versionRef ? { versionRef: row.versionRef } : {}),
    decision: toApprovalDecision(row.decision),
    approverRef: row.approverRef,
    ...(row.note ? { note: row.note } : {}),
    actorType: row.actorType,
    ...(row.actorId ? { actorId: row.actorId } : {}),
    ...(row.ipHash ? { ipHash: row.ipHash } : {}),
    ...(row.uaHash ? { uaHash: row.uaHash } : {}),
    createdAt: row.createdAt,
  };
}

interface NotificationRow {
  id: string;
  workspaceId: string;
  projectId: string | null;
  milestoneId: string | null;
  channel: string;
  template: string;
  templateVersion: string;
  subject: string | null;
  bodySnapshot: string | null;
  toRef: string;
  recipientName: string | null;
  state: string;
  providerMsgId: string | null;
  scheduledFor: Date;
  sentAt: Date | null;
  deliveredAt: Date | null;
  canceledAt: Date | null;
  attemptCount: number;
  lastError: string | null;
  nextActionAt: Date | null;
  nextActionLabel: string | null;
  trigger: string;
  policyStep: string | null;
  policyVersion: number | null;
  kind?: string | null | undefined;
  category?: string | null | undefined;
  readAt?: Date | null | undefined;
  idempotencyKey: string | null;
  createdAt: Date;
}

function toNotificationState(value: string): NotificationRecord["state"] {
  if (
    value === "queued" ||
    value === "sent" ||
    value === "delivered" ||
    value === "failed" ||
    value === "bounced"
  ) {
    return value;
  }
  throw AppError.internal("Unknown notification state");
}

function mapNotificationRow(row: NotificationRow): NotificationRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ...(row.projectId ? { projectId: row.projectId } : {}),
    ...(row.milestoneId ? { milestoneId: row.milestoneId } : {}),
    channel: row.channel,
    template: row.template,
    templateVersion: row.templateVersion,
    ...(row.subject ? { subject: row.subject } : {}),
    ...(row.bodySnapshot ? { bodySnapshot: row.bodySnapshot } : {}),
    recipient: row.toRef,
    ...(row.recipientName ? { recipientName: row.recipientName } : {}),
    state: toNotificationState(row.state),
    ...(row.providerMsgId ? { providerMessageId: row.providerMsgId } : {}),
    scheduledFor: row.scheduledFor,
    ...(row.sentAt ? { sentAt: row.sentAt } : {}),
    ...(row.deliveredAt ? { deliveredAt: row.deliveredAt } : {}),
    ...(row.canceledAt ? { canceledAt: row.canceledAt } : {}),
    attemptCount: row.attemptCount,
    ...(row.lastError ? { lastError: row.lastError } : {}),
    ...(row.nextActionAt ? { nextActionAt: row.nextActionAt } : {}),
    ...(row.nextActionLabel ? { nextActionLabel: row.nextActionLabel } : {}),
    trigger: row.trigger,
    ...(row.policyStep ? { policyStep: row.policyStep } : {}),
    ...(row.policyVersion !== null ? { policyVersion: row.policyVersion } : {}),
    ...(row.kind ? { kind: row.kind } : {}),
    ...(row.category ? { category: row.category } : {}),
    ...(row.readAt ? { readAt: row.readAt } : {}),
    ...(row.idempotencyKey ? { idempotencyKey: row.idempotencyKey } : {}),
    createdAt: row.createdAt,
  };
}

interface PaymentPlanRow {
  id: string;
  workspaceId: string;
  projectId: string;
  milestoneId: string;
  originalAmountCents: number;
  currency: string;
  installments: unknown;
  state: string;
  version: number;
  supersedesId: string | null;
  note: string | null;
  offeredAt: Date;
  acceptedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toPaymentPlanState(value: string): PaymentPlanRecord["state"] {
  if (
    value === "offered" ||
    value === "accepted" ||
    value === "active" ||
    value === "completed" ||
    value === "defaulted" ||
    value === "superseded"
  ) {
    return value;
  }
  throw AppError.internal("Unknown payment plan state");
}

function parsePlanInstallments(value: unknown): PaymentPlanInstallmentRecord[] {
  if (!Array.isArray(value)) return [];
  const out: PaymentPlanInstallmentRecord[] = [];
  for (const v of value) {
    if (typeof v !== "object" || v === null) continue;
    const r = v as Record<string, unknown>;
    if (typeof r.seq !== "number" || !Number.isInteger(r.seq) || r.seq < 1) continue;
    if (typeof r.amountCents !== "number" || !Number.isInteger(r.amountCents)) continue;
    const dueDate = r.dueDate instanceof Date ? r.dueDate : new Date(String(r.dueDate));
    if (Number.isNaN(dueDate.getTime())) continue;
    const status =
      r.status === "paid" || r.status === "missed" || r.status === "canceled"
        ? r.status
        : "scheduled";
    out.push({
      seq: r.seq,
      amountCents: r.amountCents,
      dueDate,
      status,
      ...(typeof r.paymentId === "string" ? { paymentId: r.paymentId } : {}),
      ...(r.paidAt instanceof Date
        ? { paidAt: r.paidAt }
        : typeof r.paidAt === "string" && !Number.isNaN(new Date(r.paidAt).getTime())
          ? { paidAt: new Date(r.paidAt) }
          : {}),
      ...(typeof r.note === "string" ? { note: r.note } : {}),
    });
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

function mapPaymentPlanRow(row: PaymentPlanRow): PaymentPlanRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    milestoneId: row.milestoneId,
    originalAmountCents: row.originalAmountCents,
    currency: row.currency,
    installments: parsePlanInstallments(row.installments),
    state: toPaymentPlanState(row.state),
    version: row.version,
    ...(row.supersedesId ? { supersedesId: row.supersedesId } : {}),
    ...(row.note ? { note: row.note } : {}),
    offeredAt: row.offeredAt,
    ...(row.acceptedAt ? { acceptedAt: row.acceptedAt } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

interface EvidencePackRow {
  id: string;
  workspaceId: string;
  projectId: string;
  generatedAt: Date;
  generatedBy: string;
  agreementVersionHashes: string[];
  eventSeqFrom: bigint;
  eventSeqTo: bigint;
  artifactRef: string;
  sha256: string;
  disclaimerVersion: string;
}

function mapEvidencePackRow(row: EvidencePackRow): EvidencePackRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    generatedAt: row.generatedAt,
    generatedBy: row.generatedBy,
    agreementVersionHashes: [...row.agreementVersionHashes],
    eventSeqFrom: Number(row.eventSeqFrom),
    eventSeqTo: Number(row.eventSeqTo),
    artifactRef: row.artifactRef,
    sha256: row.sha256,
    disclaimerVersion: row.disclaimerVersion,
  };
}
