import type { DateRangeFilter, DecodedCursor } from '@/lib/pagination.ts';
import type { RecordStatus } from '@/lib/status.ts';

export interface TimestampedRecord {
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SoftDeletableRecord {
  readonly isActive: boolean;
  readonly deletedAt: Date | null;
}

export interface SoftDeletableEntity extends SoftDeletableRecord, TimestampedRecord {
  readonly id: string;
}

export interface SoftDeletePatch {
  readonly isActive?: boolean;
  readonly deletedAt?: Date | null;
}

export interface SeoMetadataRecord {
  readonly metaTitle: string | null;
  readonly metaDescription: string | null;
  readonly focusKeyword: string | null;
  readonly canonicalUrl: string | null;
  readonly noIndex: boolean;
  readonly ogImageUrl: string | null;
}

export type SeoMetadataPatch = Partial<SeoMetadataRecord>;

export interface CursorListParams {
  readonly limit: number;
  readonly cursor?: DecodedCursor;
}

export interface OffsetListParams {
  readonly limit: number;
  readonly offset: number;
}

export interface OffsetListResult<T> {
  readonly items: readonly T[];
  readonly total: number;
}

export interface AdminListFilter {
  readonly query?: string;
  readonly status?: RecordStatus;
}

export interface AdminDateListFilter extends AdminListFilter, DateRangeFilter {}
