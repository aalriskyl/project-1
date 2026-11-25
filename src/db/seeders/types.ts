export interface SeededUsersResult {
  readonly adminId: string;
  readonly customerId: string;
  readonly reviewerId: string;
  readonly count: number;
}

export interface SeededCategoriesResult {
  readonly idsByKey: ReadonlyMap<string, string>;
  readonly count: number;
}

export interface SeededProductsResult {
  readonly idsByKey: ReadonlyMap<string, string>;
  readonly productsCount: number;
  readonly sparepartLinksCount: number;
}

export interface SeededArticlesResult {
  readonly count: number;
}

export interface SeededReviewsResult {
  readonly count: number;
}

export interface SeedSummary {
  readonly usersEnsured: number;
  readonly categoriesEnsured: number;
  readonly productsEnsured: number;
  readonly sparepartLinksEnsured: number;
  readonly articlesEnsured: number;
  readonly reviewsEnsured: number;
}
