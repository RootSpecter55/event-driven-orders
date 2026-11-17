import request from 'supertest';
import { createApp } from '../../src/app';
import { adminAuth, closeShared, createProduct, resetState } from './helpers';

const app = createApp();

beforeEach(resetState);
afterAll(closeShared);

describe('products', () => {
  it('creates, reads, updates and restocks a product', async () => {
    const product = await createProduct(app, 2);

    const got = await request(app).get(`/products/${product.id}`).expect(200);
    expect(got.body.data).toMatchObject({ sku: 'MUG-1', priceCents: 1200, stock: 2 });

    const updated = await request(app)
      .patch(`/products/${product.id}`)
      .set(adminAuth)
      .send({ priceCents: 1500 })
      .expect(200);
    expect(updated.body.data.priceCents).toBe(1500);

    const restocked = await request(app)
      .post(`/products/${product.id}/restock`)
      .set(adminAuth)
      .send({ quantity: 8 })
      .expect(200);
    expect(restocked.body.data.stock).toBe(10);
  });

  it('paginates the list', async () => {
    for (const sku of ['A', 'B', 'C']) await createProduct(app, 1, sku);
    const res = await request(app).get('/products?page=2&pageSize=2').expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta).toEqual({ page: 2, pageSize: 2, total: 3, totalPages: 2 });
  });

  it('rejects writes without the admin key, duplicate SKUs and invalid bodies', async () => {
    await request(app)
      .post('/products')
      .send({ sku: 'X', name: 'X', priceCents: 1, stock: 1 })
      .expect(401);

    await createProduct(app, 1, 'DUP');
    const dup = await request(app)
      .post('/products')
      .set(adminAuth)
      .send({ sku: 'DUP', name: 'Again', priceCents: 100, stock: 1 });
    expect(dup.status).toBe(409);

    const invalid = await request(app)
      .post('/products')
      .set(adminAuth)
      .send({ sku: 'bad sku!', name: '', priceCents: -1, stock: 1.5 });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual([
      'name',
      'priceCents',
      'sku',
      'stock',
    ]);
  });

  it('returns 404 in the error envelope for unknown products and routes', async () => {
    const res = await request(app).get('/products/00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Product not found' } });
    await request(app).get('/nope').expect(404);
  });
});
