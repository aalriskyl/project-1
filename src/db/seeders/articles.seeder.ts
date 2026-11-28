import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '@/db/client.ts';
import { articles } from '@/db/schema/articles.ts';
import type { SeededArticlesResult } from '@/db/seeders/types.ts';
import { generateId } from '@/lib/auth/id.ts';

interface SeedArticleSpec {
  readonly title: string;
  readonly slug: string;
  readonly excerpt: string;
  readonly contentMd: string;
  readonly coverImageUrl: string | null;
  readonly metaTitle: string;
  readonly metaDescription: string;
  readonly focusKeyword: string;
  readonly canonicalUrl: string | null;
  readonly noIndex: boolean;
  readonly ogImageUrl: string | null;
  readonly tags: string[];
  readonly relatedProductKeys: readonly string[];
  readonly isPublished: boolean;
}

const ARTICLE_SPECS: readonly SeedArticleSpec[] = [
  {
    title: 'Cara Memilih Genset Silent 30 kVA vs 50 kVA untuk Pabrik & Gedung',
    slug: 'cara-memilih-genset-silent-30-kva-vs-50-kva',
    excerpt:
      'Panduan menghitung beban puncak (kW/kVA), konsumsi solar, dan jadwal perawatan genset Perkins 30 kVA dan 50 kVA.',
    contentMd:
      '## Menghitung Kebutuhan Daya Listrik\n\nSebelum membeli genset silent, hitung total beban aktif (kW) lalu bagi dengan faktor daya `0.8` untuk mendapatkan kapasitas kVA ideal.\n\n## Perbandingan Perkins 30 kVA vs 50 kVA\n\n- **Tsuzumi TPG30 (30 kVA):** Optimal untuk beban 18–22 kW.\n- **Tsuzumi TPG50 (50 kVA):** Optimal untuk beban 32–38 kW dengan margin lonjakan motor listrik.',
    coverImageUrl: 'https://placehold.co/1200x630.webp',
    metaTitle: 'Cara Memilih Genset Silent 30 kVA vs 50 kVA | Panduan Tsuzumi',
    metaDescription:
      'Pelajari rumus menghitung kebutuhan kVA dan perbandingan genset silent Perkins 30 kVA vs 50 kVA untuk bisnis Anda.',
    focusKeyword: 'genset silent 30 kva',
    canonicalUrl: null,
    noIndex: false,
    ogImageUrl: 'https://placehold.co/1200x630.webp',
    tags: ['genset', 'perkins', 'panduan'],
    relatedProductKeys: ['tpg30', 'tpg50'],
    isPublished: true,
  },
  {
    title: 'Mesin Potong Aspal: Fungsi, Spesifikasi, dan Tips Perawatan',
    slug: 'mesin-potong-aspal-fungsi-spesifikasi-dan-perawatan',
    excerpt:
      'Kenali komponen penting concrete cutter agar hasil potongan jalan aspal presisi dan mata pisau diamond blade lebih awet.',
    contentMd:
      '## Fungsi Mesin Potong Aspal\n\nConcrete cutter digunakan untuk membuat sambungan ekspansi beton dan memotong lapisan aspal sebelum perbaikan jalan.\n\n## Tips Perawatan Harian\n\n1. Pastikan tangki air pendingin selalu terisi sebelum memotong.\n2. Bersihkan debu beton dari filter udara setiap selesai proyek.',
    coverImageUrl: 'https://placehold.co/1200x630.webp',
    metaTitle: 'Mesin Potong Aspal: Fungsi & Tips Perawatan | Tsuzumi Japan',
    metaDescription:
      'Panduan lengkap fungsi concrete cutter, pemilihan pisau diamond blade, dan tips perawatan mesin potong aspal.',
    focusKeyword: 'mesin potong aspal',
    canonicalUrl: null,
    noIndex: false,
    ogImageUrl: 'https://placehold.co/1200x630.webp',
    tags: ['konstruksi', 'concrete-cutter', 'panduan'],
    relatedProductKeys: ['tcc500'],
    isPublished: true,
  },
  {
    title: 'Draft Panduan Instalasi Genset Cummins 100 kVA',
    slug: 'draft-panduan-instalasi-genset-cummins-100-kva',
    excerpt: 'Catatan internal persiapan ruang genset, exhaust ducting, dan panel ATS.',
    contentMd: '## Draft\n\nArtikel ini belum dipublikasikan ke halaman publik.',
    coverImageUrl: null,
    metaTitle: 'Draft Instalasi Genset 100 kVA',
    metaDescription: 'Draft internal.',
    focusKeyword: 'instalasi genset 100 kva',
    canonicalUrl: null,
    noIndex: false,
    ogImageUrl: null,
    tags: ['genset', 'cummins'],
    relatedProductKeys: ['tcg100'],
    isPublished: false,
  },
  {
    title: 'Syarat Promo Internal Q4 (NoIndex)',
    slug: 'syarat-promo-internal-q4-noindex',
    excerpt:
      'Halaman syarat promo yang dapat diakses via link langsung tetapi disembunyikan dari sitemap.',
    contentMd:
      '## Syarat & Ketentuan\n\nHalaman ini menandai `noIndex: true` untuk verifikasi SEO.',
    coverImageUrl: null,
    metaTitle: 'Syarat Promo Internal Q4',
    metaDescription: 'Halaman promo khusus link langsung.',
    focusKeyword: 'promo tsuzumi',
    canonicalUrl: 'https://tsuzumijapan.com/articles/cara-memilih-genset-silent-30-kva-vs-50-kva',
    noIndex: true,
    ogImageUrl: null,
    tags: ['promo'],
    relatedProductKeys: [],
    isPublished: true,
  },
];

async function ensureArticle(
  database: Database,
  spec: SeedArticleSpec,
  authorId: string,
  productIdsByKey: ReadonlyMap<string, string>,
): Promise<string> {
  const [existing] = await database
    .select({ id: articles.id })
    .from(articles)
    .where(and(eq(articles.slug, spec.slug), isNull(articles.deletedAt)))
    .limit(1);

  if (existing !== undefined) {
    return existing.id;
  }

  const id = generateId();
  const relatedProductIds = spec.relatedProductKeys.flatMap((key) => {
    const prodId = productIdsByKey.get(key);
    return prodId !== undefined ? [prodId] : [];
  });

  await database.insert(articles).values({
    id,
    authorId,
    title: spec.title,
    slug: spec.slug,
    excerpt: spec.excerpt,
    contentMd: spec.contentMd,
    coverImageUrl: spec.coverImageUrl,
    metaTitle: spec.metaTitle,
    metaDescription: spec.metaDescription,
    focusKeyword: spec.focusKeyword,
    canonicalUrl: spec.canonicalUrl,
    noIndex: spec.noIndex,
    ogImageUrl: spec.ogImageUrl,
    tags: spec.tags,
    relatedProductIds,
    isPublished: spec.isPublished,
    publishedAt: spec.isPublished ? new Date() : null,
  });
  return id;
}

/**
 * Seeds published SEO guides, a draft article, and a published `noIndex` article.
 */
export async function seedArticles(
  database: Database,
  authorId: string,
  productIdsByKey: ReadonlyMap<string, string>,
): Promise<SeededArticlesResult> {
  for (const spec of ARTICLE_SPECS) {
    await ensureArticle(database, spec, authorId, productIdsByKey);
  }
  return { count: ARTICLE_SPECS.length };
}
