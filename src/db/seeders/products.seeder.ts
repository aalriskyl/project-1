import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '@/db/client.ts';
import {
  type ProductCustomSpecRow,
  type ProductMediaItemRow,
  type ProductSpecsMap,
  productSpareparts,
  products,
} from '@/db/schema/products.ts';
import type { SeededProductsResult } from '@/db/seeders/types.ts';
import { generateId } from '@/lib/id.ts';

interface SeedProductSpec {
  readonly key: string;
  readonly categoryKey: string;
  readonly brandSlug: string;
  readonly name: string;
  readonly slug: string;
  readonly sku: string;
  readonly productType: 'equipment' | 'sparepart';
  readonly descriptionMd: string;
  readonly metaTitle: string;
  readonly metaDescription: string;
  readonly focusKeyword: string;
  readonly canonicalUrl: string | null;
  readonly noIndex: boolean;
  readonly ogImageUrl: string | null;
  readonly priceIdr: number;
  readonly requiresQuote: boolean;
  readonly stock: number;
  readonly isFeatured: boolean;
  readonly media: Omit<ProductMediaItemRow, 'id'>[];
  readonly specs: ProductSpecsMap;
  readonly customSpecs?: ProductCustomSpecRow[];
  readonly lengthCm: string | null;
  readonly widthCm: string | null;
  readonly heightCm: string | null;
  readonly weightKg: string | null;
}

const PRODUCT_SPECS: readonly SeedProductSpec[] = [
  {
    key: 'tpg30',
    categoryKey: 'engine-perkins',
    brandSlug: 'perkins',
    name: 'Genset 30 kVA Silent Diesel Tsuzumi TPG30 Powered by Perkins',
    slug: 'genset-30-kva-silent-diesel-tsuzumi-tpg30',
    sku: 'TPG30-SILENT',
    productType: 'equipment',
    descriptionMd:
      '## Keunggulan Tsuzumi TPG30\n\nGenset silent 30 kVA menggunakan mesin **Perkins 1103A-33G** yang hemat bahan bakar, tingkat kebisingan rendah (< 68 dB @ 7m), serta dilengkapi panel kontrol DeepSea.\n\n- Cocok untuk klinik, minimarket, kantor, dan ruko\n- Garansi resmi 1 tahun / 2000 jam kerja',
    metaTitle: 'Genset 30 kVA Silent Perkins Tsuzumi TPG30 | Harga & Spesifikasi',
    metaDescription:
      'Jual Genset 30 kVA Silent Diesel Tsuzumi TPG30 engine Perkins 1103A-33G. Bergaransi resmi PT Pelangi Teknik Indonesia.',
    focusKeyword: 'genset 30 kva silent perkins',
    canonicalUrl: null,
    noIndex: false,
    ogImageUrl: 'https://placehold.co/1200x630.webp',
    priceIdr: 177_500_000,
    requiresQuote: true,
    stock: 4,
    isFeatured: true,
    media: [
      {
        type: 'image',
        url: 'https://placehold.co/800x600.webp',
        altText: 'Genset 30 kVA Silent Diesel Tsuzumi TPG30 Tampak Depan',
      },
      {
        type: 'video',
        url: 'https://www.youtube.com/watch?v=ObH3ZNu6OFU',
        altText: 'Video Uji Beban Genset Tsuzumi TPG30',
      },
    ],
    specs: {
      rated_power_kva: 30,
      voltage: '220/380V',
      silent_canopy: true,
      fuel_type: 'Diesel',
      engine_model: 'Perkins 1103A-33G',
    },
    customSpecs: [
      { label: 'Alternator', value: 'Stamford UCI224D' },
      { label: 'Control Panel', value: 'DeepSea DSE4520' },
      { label: 'Noise Level', value: '< 68', unit: 'dB @ 7m' },
    ],
    lengthCm: '215.00',
    widthCm: '95.00',
    heightCm: '125.00',
    weightKg: '920.50',
  },
  {
    key: 'tpg50',
    categoryKey: 'engine-perkins',
    brandSlug: 'perkins',
    name: 'Genset 50 kVA Silent Diesel Tsuzumi TPG50 Powered by Perkins',
    slug: 'genset-50-kva-silent-diesel-tsuzumi-tpg50',
    sku: 'TPG50-SILENT',
    productType: 'equipment',
    descriptionMd:
      '## Keunggulan Tsuzumi TPG50\n\nGenset 50 kVA bertenaga **Perkins 1103A-33TG1** dengan alternator Stamford dan canopy kedap suara tebal 2.5 mm.\n\n- Ideal untuk pabrik skala menengah, hotel, dan restoran besar\n- Ready stock pengiriman seluruh Indonesia',
    metaTitle: 'Genset 50 kVA Silent Perkins Tsuzumi TPG50 | Harga & Spesifikasi',
    metaDescription:
      'Genset 50 kVA silent Perkins 1103A-33TG1 original dengan layanan instalasi dan garansi purna jual.',
    focusKeyword: 'genset 50 kva silent perkins',
    canonicalUrl: null,
    noIndex: false,
    ogImageUrl: 'https://placehold.co/1200x630.webp',
    priceIdr: 235_000_000,
    requiresQuote: true,
    stock: 2,
    isFeatured: true,
    media: [
      {
        type: 'image',
        url: 'https://placehold.co/800x600.webp',
        altText: 'Genset 50 kVA Silent Diesel Tsuzumi TPG50',
      },
    ],
    specs: {
      rated_power_kva: 50,
      voltage: '220/380V',
      silent_canopy: true,
      fuel_type: 'Diesel',
      engine_model: 'Perkins 1103A-33TG1',
    },
    lengthCm: '235.00',
    widthCm: '100.00',
    heightCm: '135.00',
    weightKg: '1150.00',
  },
  {
    key: 'tcg100',
    categoryKey: 'engine-cummins',
    brandSlug: 'cummins',
    name: 'Genset 100 kVA Silent Diesel Tsuzumi TCG100 Powered by Cummins',
    slug: 'genset-100-kva-silent-diesel-tsuzumi-tcg100',
    sku: 'TCG100-SILENT',
    productType: 'equipment',
    descriptionMd:
      '## Keunggulan Tsuzumi TCG100\n\nGenset industri 100 kVA dengan mesin **Cummins 6BT5.9-G2** untuk operasional proyek dan pabrik 24 jam.',
    metaTitle: 'Genset 100 kVA Silent Cummins Tsuzumi TCG100',
    metaDescription: 'Genset silent 100 kVA engine Cummins 6BT5.9-G2 heavy duty bergaransi resmi.',
    focusKeyword: 'genset 100 kva cummins',
    canonicalUrl: null,
    noIndex: false,
    ogImageUrl: 'https://placehold.co/1200x630.webp',
    priceIdr: 348_000_000,
    requiresQuote: true,
    stock: 1,
    isFeatured: false,
    media: [
      {
        type: 'image',
        url: 'https://placehold.co/800x600.webp',
        altText: 'Genset 100 kVA Silent Cummins Tsuzumi TCG100',
      },
    ],
    specs: {
      rated_power_kva: 100,
      voltage: '220/380V',
      silent_canopy: true,
      fuel_type: 'Diesel',
      engine_model: 'Cummins 6BT5.9-G2',
    },
    lengthCm: '280.00',
    widthCm: '110.00',
    heightCm: '155.00',
    weightKg: '1620.00',
  },
  {
    key: 'tcc500',
    categoryKey: 'concrete-cutter',
    brandSlug: 'tsuzumi',
    name: 'Mesin Potong Aspal Concrete Cutter Tsuzumi TCC500',
    slug: 'mesin-potong-aspal-concrete-cutter-tsuzumi-tcc500',
    sku: 'TCC500-STD',
    productType: 'equipment',
    descriptionMd:
      '## Spesifikasi Utama TCC500\n\nMesin potong aspal dan beton **Tsuzumi TCC500** dengan penggerak bensin 13 HP dan kedalaman potong hingga 170 mm. Dapat dipesan langsung melalui checkout online.',
    metaTitle: 'Mesin Potong Aspal Concrete Cutter Tsuzumi TCC500',
    metaDescription:
      'Jual concrete cutter Tsuzumi TCC500 13 HP siap kirim. Tangguh untuk pemotongan jalan aspal dan lantai beton.',
    focusKeyword: 'mesin potong aspal concrete cutter',
    canonicalUrl: null,
    noIndex: false,
    ogImageUrl: 'https://placehold.co/1200x630.webp',
    priceIdr: 14_500_000,
    requiresQuote: false,
    stock: 12,
    isFeatured: true,
    media: [
      {
        type: 'image',
        url: 'https://placehold.co/800x600.webp',
        altText: 'Concrete Cutter Tsuzumi TCC500',
      },
    ],
    specs: {
      engine_power_hp: 13,
      max_cutting_depth_mm: 170,
    },
    lengthCm: '112.00',
    widthCm: '62.00',
    heightCm: '98.00',
    weightKg: '118.00',
  },
  {
    key: 'filter-oil-perkins',
    categoryKey: 'spareparts',
    brandSlug: 'perkins',
    name: 'Perkins Oil Filter Original 2654403',
    slug: 'perkins-oil-filter-original-2654403',
    sku: 'PK-2654403',
    productType: 'sparepart',
    descriptionMd:
      'Filter oli original **Perkins 2654403** untuk perawatan berkala setiap 250 jam kerja pada seri engine 1103A.',
    metaTitle: 'Perkins Oil Filter Original 2654403 | Sparepart Genset',
    metaDescription:
      'Beli filter oli Perkins 2654403 original untuk genset silent 30 kVA dan 50 kVA.',
    focusKeyword: 'perkins oil filter 2654403',
    canonicalUrl: null,
    noIndex: false,
    ogImageUrl: null,
    priceIdr: 285_000,
    requiresQuote: false,
    stock: 45,
    isFeatured: false,
    media: [
      {
        type: 'image',
        url: 'https://placehold.co/600x600.webp',
        altText: 'Perkins Oil Filter 2654403',
      },
    ],
    specs: {},
    lengthCm: '12.00',
    widthCm: '12.00',
    heightCm: '18.00',
    weightKg: '0.85',
  },
  {
    key: 'filter-fuel-perkins',
    categoryKey: 'spareparts',
    brandSlug: 'perkins',
    name: 'Perkins Fuel Filter Original 26560201',
    slug: 'perkins-fuel-filter-original-26560201',
    sku: 'PK-26560201',
    productType: 'sparepart',
    descriptionMd:
      'Filter bahan bakar solar **Perkins 26560201** menyaring partikel halus dan air untuk menjaga injector tetap awet.',
    metaTitle: 'Perkins Fuel Filter Original 26560201 | Sparepart Genset',
    metaDescription:
      'Filter solar original Perkins 26560201 siap kirim untuk genset diesel 30 - 60 kVA.',
    focusKeyword: 'perkins fuel filter 26560201',
    canonicalUrl: null,
    noIndex: false,
    ogImageUrl: null,
    priceIdr: 320_000,
    requiresQuote: false,
    stock: 38,
    isFeatured: false,
    media: [
      {
        type: 'image',
        url: 'https://placehold.co/600x600.webp',
        altText: 'Perkins Fuel Filter 26560201',
      },
    ],
    specs: {},
    lengthCm: '10.00',
    widthCm: '10.00',
    heightCm: '16.00',
    weightKg: '0.65',
  },
];

const SPAREPART_LINKS: readonly {
  readonly parentKey: string;
  readonly partKey: string;
  readonly note: string;
}[] = [
  { parentKey: 'tpg30', partKey: 'filter-oil-perkins', note: 'Ganti setiap 250 jam operasi' },
  { parentKey: 'tpg30', partKey: 'filter-fuel-perkins', note: 'Ganti setiap 500 jam operasi' },
  { parentKey: 'tpg50', partKey: 'filter-oil-perkins', note: 'Ganti setiap 250 jam operasi' },
  { parentKey: 'tpg50', partKey: 'filter-fuel-perkins', note: 'Ganti setiap 500 jam operasi' },
];

async function ensureProduct(
  database: Database,
  spec: SeedProductSpec,
  categoryId: string,
): Promise<string> {
  const [existing] = await database
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.slug, spec.slug), isNull(products.deletedAt)))
    .limit(1);

  if (existing !== undefined) {
    return existing.id;
  }

  const id = generateId();
  const mediaWithIds: ProductMediaItemRow[] = spec.media.map((item) => ({
    id: generateId(),
    ...item,
  }));
  const primaryImageUrl = mediaWithIds.find((m) => m.type === 'image')?.url ?? null;

  await database.insert(products).values({
    id,
    categoryId,
    brandSlug: spec.brandSlug,
    name: spec.name,
    slug: spec.slug,
    sku: spec.sku,
    productType: spec.productType,
    descriptionMd: spec.descriptionMd,
    metaTitle: spec.metaTitle,
    metaDescription: spec.metaDescription,
    focusKeyword: spec.focusKeyword,
    canonicalUrl: spec.canonicalUrl,
    noIndex: spec.noIndex,
    ogImageUrl: spec.ogImageUrl,
    priceIdr: spec.priceIdr,
    requiresQuote: spec.requiresQuote,
    stock: spec.stock,
    isFeatured: spec.isFeatured,
    isActive: true,
    primaryImageUrl,
    media: mediaWithIds,
    specs: spec.specs,
    customSpecs: spec.customSpecs ?? [],
    lengthCm: spec.lengthCm,
    widthCm: spec.widthCm,
    heightCm: spec.heightCm,
    weightKg: spec.weightKg,
  });
  return id;
}

/**
 * Seeds equipment (B2B RFQ & instant-checkout), spare parts, and `product_spareparts` compatibility links.
 */
export async function seedProducts(
  database: Database,
  categoryIdsByKey: ReadonlyMap<string, string>,
): Promise<SeededProductsResult> {
  const idsByKey = new Map<string, string>();

  for (const spec of PRODUCT_SPECS) {
    const categoryId = categoryIdsByKey.get(spec.categoryKey);
    if (categoryId === undefined) {
      throw new Error(`Missing seeded category for key "${spec.categoryKey}"`);
    }
    const prodId = await ensureProduct(database, spec, categoryId);
    idsByKey.set(spec.key, prodId);
  }

  for (const link of SPAREPART_LINKS) {
    const parentProductId = idsByKey.get(link.parentKey);
    const sparepartProductId = idsByKey.get(link.partKey);
    if (parentProductId !== undefined && sparepartProductId !== undefined) {
      await database
        .insert(productSpareparts)
        .values({ parentProductId, sparepartProductId, note: link.note })
        .onConflictDoNothing();
    }
  }

  return {
    idsByKey,
    productsCount: PRODUCT_SPECS.length,
    sparepartLinksCount: SPAREPART_LINKS.length,
  };
}
