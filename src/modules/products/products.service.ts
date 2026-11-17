import type { DbContext } from '../../common/db';
import { ConflictError, NotFoundError } from '../../common/errors';
import { toPage, toSkipTake } from '../../common/pagination';
import type { ProductRepository } from './products.repository';
import type {
  CreateProductInput,
  ListProductsQuery,
  RestockInput,
  UpdateProductInput,
} from './products.schemas';

export class ProductsService {
  constructor(
    private readonly db: DbContext,
    private readonly products: ProductRepository,
  ) {}

  async create(input: CreateProductInput) {
    const db = this.db.client();
    if (await this.products.findBySku(db, input.sku)) {
      throw new ConflictError(`A product with SKU ${input.sku} already exists`);
    }
    return this.products.create(db, input);
  }

  async list(query: ListProductsQuery) {
    const { items, total } = await this.products.list(this.db.client(), toSkipTake(query));
    return toPage(items, total, query);
  }

  async get(productId: string) {
    const product = await this.products.findById(this.db.client(), productId);
    if (!product) throw new NotFoundError('Product');
    return product;
  }

  async update(productId: string, input: UpdateProductInput) {
    await this.get(productId);
    return this.products.update(this.db.client(), productId, input);
  }

  /** An atomic increment, so a restock never loses a concurrent reservation's decrement. */
  async restock(productId: string, { quantity }: RestockInput) {
    await this.get(productId);
    return this.products.addStock(this.db.client(), productId, quantity);
  }
}
