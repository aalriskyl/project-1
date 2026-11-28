import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '@/db/client.ts';
import { categories, type SpecFieldDefRow } from '@/db/schema/categories.ts';
import type { SeededCategoriesResult } from '@/db/seeders/types.ts';
import { generateId } from '@/lib/auth/id.ts';

interface SeedCategorySpec {
  readonly key: string;
  readonly parentKey: string | null;
  readonly name: string;
  readonly slug: string;
  readonly description: string;
  readonly metaTitle: string;
  readonly metaDescription: string;
  readonly focusKeyword: string;
  readonly canonicalUrl: string | null;
  readonly noIndex: boolean;
  readonly ogImageUrl: string | null;
  readonly imageUrl: string | null;
  readonly specSchema: SpecFieldDefRow[];
  readonly sortOrder: number;
}

const CATEGORY_SPECS: readonly SeedCategorySpec[] = [
  {
    key: 'genset-silent',
    parentKey: null,
    name: 'Genset Silent',
    slug: 'genset-silent',
    description: 'Genset diesel silent canopy untuk industri, proyek, hotel, dan rumah sakit.',
    metaTitle: 'Jual Genset Silent 10 - 500 kVA Bergaransi | Tsuzumi Japan',
    metaDescription:
      'Distributor genset silent diesel Tsuzumi Japan dengan engine Perkins & Cummins. Garansi resmi dan layanan purna jual seluruh Indonesia.',
    focusKeyword: 'genset silent',
    canonicalUrl: null,
    noIndex: false,
    ogImageUrl: 'https://placehold.co/1200x630.webp',
    imageUrl: 'https://placehold.co/800x600.webp',
    specSchema: [
      { key: 'rated_power_kva', label: 'Rated Power', unit: 'kVA', type: 'number', sortOrder: 10 },
      { key: 'voltage', label: 'Voltage', unit: 'V', type: 'text', sortOrder: 20 },
      { key: 'silent_canopy', label: 'Silent Canopy', type: 'boolean', sortOrder: 30 },
      { key: 'fuel_type', label: 'Fuel Type', type: 'text', sortOrder: 40 },
    ],
    sortOrder: 10,
  },
  {
    key: 'engine-perkins',
    parentKey: 'genset-silent',
    name: 'Engine Perkins',
    slug: 'engine-perkins',
    description: 'Genset silent bertenaga mesin diesel Perkins original UK.',
    metaTitle: 'Genset Silent Engine Perkins Original | Tsuzumi Japan',
    metaDescription:
      'Pilihan genset silent Perkins 20 kVA hingga 500 kVA dengan efisiensi bahan bakar tinggi dan suku cadang lengkap.',
    focusKeyword: 'genset perkins',
    canonicalUrl: null,
    noIndex: false,
    ogImageUrl: 'https://placehold.co/1200x630.webp',
    imageUrl: 'https://placehold.co/800x600.webp',
    specSchema: [{ key: 'engine_model', label: 'Engine Model', type: 'text', sortOrder: 50 }],
    sortOrder: 11,
  },
  {
    key: 'engine-cummins',
    parentKey: 'genset-silent',
    name: 'Engine Cummins',
    slug: 'engine-cummins',
    description: 'Genset silent bertenaga mesin diesel Cummins heavy-duty.',
    metaTitle: 'Genset Silent Engine Cummins Heavy Duty | Tsuzumi Japan',
    metaDescription:
      'Genset silent Cummins untuk kebutuhan daya kontinu pabrik, gedung bertingkat, dan pertambangan.',
    focusKeyword: 'genset cummins',
    canonicalUrl: null,
    noIndex: false,
    ogImageUrl: 'https://placehold.co/1200x630.webp',
    imageUrl: 'https://placehold.co/800x600.webp',
    specSchema: [{ key: 'engine_model', label: 'Engine Model', type: 'text', sortOrder: 50 }],
    sortOrder: 12,
  },
  {
    key: 'alat-konstruksi',
    parentKey: null,
    name: 'Alat Konstruksi',
    slug: 'alat-konstruksi',
    description: 'Peralatan konstruksi jalan dan beton berkualitas industri.',
    metaTitle: 'Alat Konstruksi Jalan & Beton | Tsuzumi Japan',
    metaDescription:
      'Mesin potong aspal, stamper kuda, plate compactor, dan vibrator beton Tsuzumi Japan.',
    focusKeyword: 'alat konstruksi',
    canonicalUrl: null,
    noIndex: false,
    ogImageUrl: 'https://placehold.co/1200x630.webp',
    imageUrl: 'https://placehold.co/800x600.webp',
    specSchema: [
      { key: 'engine_power_hp', label: 'Engine Power', unit: 'HP', type: 'number', sortOrder: 10 },
      {
        key: 'max_cutting_depth_mm',
        label: 'Max Cutting Depth',
        unit: 'mm',
        type: 'number',
        sortOrder: 20,
      },
    ],
    sortOrder: 20,
  },
  {
    key: 'concrete-cutter',
    parentKey: 'alat-konstruksi',
    name: 'Concrete Cutter',
    slug: 'concrete-cutter',
    description: 'Mesin potong aspal dan beton presisi untuk proyek jalan.',
    metaTitle: 'Jual Mesin Potong Aspal & Concrete Cutter | Tsuzumi Japan',
    metaDescription:
      'Concrete cutter Tsuzumi dengan tangki air terintegrasi dan rangka baja kokoh.',
    focusKeyword: 'concrete cutter',
    canonicalUrl: null,
    noIndex: false,
    ogImageUrl: 'https://placehold.co/1200x630.webp',
    imageUrl: 'https://placehold.co/800x600.webp',
    specSchema: [],
    sortOrder: 21,
  },
  {
    key: 'spareparts',
    parentKey: null,
    name: 'Spareparts',
    slug: 'spareparts',
    description: 'Suku cadang original filter oli, filter solar, AVR, dan modul kontrol.',
    metaTitle: 'Sparepart Genset & Alat Konstruksi Original | Tsuzumi Japan',
    metaDescription:
      'Filter oli Perkins, filter bahan bakar, AVR, dan suku cadang resmi siap kirim.',
    focusKeyword: 'sparepart genset',
    canonicalUrl: null,
    noIndex: false,
    ogImageUrl: 'https://placehold.co/1200x630.webp',
    imageUrl: 'https://placehold.co/800x600.webp',
    specSchema: [],
    sortOrder: 30,
  },
];

async function ensureCategory(
  database: Database,
  spec: SeedCategorySpec,
  parentId: string | null,
): Promise<string> {
  const [existing] = await database
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.slug, spec.slug), isNull(categories.deletedAt)))
    .limit(1);

  if (existing !== undefined) {
    return existing.id;
  }

  const id = generateId();
  await database.insert(categories).values({
    id,
    parentId,
    name: spec.name,
    slug: spec.slug,
    description: spec.description,
    metaTitle: spec.metaTitle,
    metaDescription: spec.metaDescription,
    focusKeyword: spec.focusKeyword,
    canonicalUrl: spec.canonicalUrl,
    noIndex: spec.noIndex,
    ogImageUrl: spec.ogImageUrl,
    imageUrl: spec.imageUrl,
    bannerImageUrl: null,
    specSchema: spec.specSchema,
    sortOrder: spec.sortOrder,
    isActive: true,
  });
  return id;
}

/**
 * Seeds the 2-level Tsuzumi Japan category taxonomy with inherited `specSchema` and Yoast SEO fields.
 */
export async function seedCategories(database: Database): Promise<SeededCategoriesResult> {
  const idsByKey = new Map<string, string>();

  for (const spec of CATEGORY_SPECS) {
    const parentId = spec.parentKey !== null ? (idsByKey.get(spec.parentKey) ?? null) : null;
    const catId = await ensureCategory(database, spec, parentId);
    idsByKey.set(spec.key, catId);
  }

  return {
    idsByKey,
    count: CATEGORY_SPECS.length,
  };
}
