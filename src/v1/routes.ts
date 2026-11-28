import { OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { defaultOpenApiHook } from '@/lib/shared/errors.ts';
import { requireAuth } from '@/middlewares/auth/auth.ts';
import {
  createAdminArticlesRoutes,
  createPublicArticlesRoutes,
} from '@/modules/articles/articles.routes.ts';
import type { ArticlesService } from '@/modules/articles/articles.service.ts';
import { createAuthRoutes } from '@/modules/auth/auth.routes.ts';
import type { AuthService } from '@/modules/auth/auth.service.ts';
import {
  createAdminInquiriesRoutes,
  createPublicInquiriesRoutes,
} from '@/modules/inquiries/inquiries.routes.ts';
import type { InquiriesService } from '@/modules/inquiries/inquiries.service.ts';
import {
  createAdminCatalogRoutes,
  createPublicCatalogRoutes,
} from '@/modules/catalog/catalog.routes.ts';
import type { CatalogService } from '@/modules/catalog/catalog.service.ts';
import { createAdminMediaRoutes } from '@/modules/media/media.routes.ts';
import type { MediaService } from '@/modules/media/media.service.ts';
import {
  createAdminProductsRoutes,
  createPublicProductsRoutes,
} from '@/modules/products/products.routes.ts';
import type { ProductsService } from '@/modules/products/products.service.ts';
import {
  createAdminReviewsRoutes,
  createProductReviewsRoutes,
} from '@/modules/reviews/reviews.routes.ts';
import type { ReviewsService } from '@/modules/reviews/reviews.service.ts';
import { createSeoRoutes } from '@/modules/seo/seo.routes.ts';
import type { SeoService } from '@/modules/seo/seo.service.ts';
import { createUsersRoutes } from '@/modules/users/users.routes.ts';
import type { UsersService } from '@/modules/users/users.service.ts';
import type { AppEnv } from '@/types/app.ts';

export interface V1RoutesDependencies {
  readonly authService: AuthService;
  readonly usersService: UsersService;
  readonly catalogService: CatalogService;
  readonly productsService: ProductsService;
  readonly reviewsService: ReviewsService;
  readonly articlesService: ArticlesService;
  readonly seoService: SeoService;
  readonly mediaService: MediaService;
  readonly globalRateLimiter: MiddlewareHandler<AppEnv>;
  readonly authRateLimiter: MiddlewareHandler<AppEnv>;
  readonly inquiryRateLimiter: MiddlewareHandler<AppEnv>;
  readonly inquiryService: InquiriesService;
  readonly authMiddleware?: MiddlewareHandler<AppEnv>;
}

/**
 * Central `/v1` router aggregator.
 * Mounts all v1 feature modules while keeping infrastructure, services, and repositories version-agnostic.
 */
export function createV1Routes(deps: V1RoutesDependencies) {
  const v1 = new OpenAPIHono<AppEnv>({ defaultHook: defaultOpenApiHook });
  const authGuard = deps.authMiddleware ?? requireAuth;

  v1.use('*', deps.globalRateLimiter);

  return v1
    .route('/auth', createAuthRoutes(deps.authService, deps.authRateLimiter, authGuard))
    .route('/users', createUsersRoutes(deps.usersService, authGuard))
    .route('/categories', createPublicCatalogRoutes(deps.catalogService))
    .route('/products', createProductReviewsRoutes(deps.reviewsService, authGuard))
    .route('/products', createPublicProductsRoutes(deps.productsService))
    .route('/articles', createPublicArticlesRoutes(deps.articlesService))
    .route('/inquiries', createPublicInquiriesRoutes(deps.inquiryService, deps.inquiryRateLimiter))
    .route('/seo', createSeoRoutes(deps.catalogService, deps.seoService))
    .route('/admin/categories', createAdminCatalogRoutes(deps.catalogService, authGuard))
    .route('/admin/products', createAdminProductsRoutes(deps.productsService, authGuard))
    .route('/admin/reviews', createAdminReviewsRoutes(deps.reviewsService, authGuard))
    .route('/admin/articles', createAdminArticlesRoutes(deps.articlesService, authGuard))
    .route('/admin/inquiries', createAdminInquiriesRoutes(deps.inquiryService, authGuard))
    .route('/admin/media', createAdminMediaRoutes(deps.mediaService, authGuard));
}
