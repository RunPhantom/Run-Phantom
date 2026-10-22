import type { Dataset, DatasetRevision } from "../evaluations/protocol";
import type { PromotionReceipt, ReviewItem, ReviewQueue } from "../review-queues/protocol";
import type { Role } from "./protocol";

export interface TeamReviewActor { accountId: string; role: Role }
export interface TeamApprovalWitness extends TeamReviewActor { approvedAt: number; revision: number; approvedHash: string }
export interface TeamReviewQueue extends ReviewQueue { projectId: string }
export interface TeamReviewItem extends Omit<ReviewItem, "reviewSource"> {
  projectId: string; projectSourceHash: string;
  reviewSource: "projectAccount" | null; approvalWitness: TeamApprovalWitness | null;
}
export interface TeamReviewDatasetRevision extends DatasetRevision { projectId: string }
export interface TeamReviewDataset extends Dataset { projectId: string }
export interface TeamReviewReceipt extends PromotionReceipt { projectId: string; queueId: string; actor: TeamReviewActor }
export const TEAM_REVIEW_ITEM_BYTES = 96 * 1024;
export const TEAM_REVIEW_REVISION_BYTES = 2 * 1024 * 1024;
