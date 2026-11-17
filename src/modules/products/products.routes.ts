import { Router, type RequestHandler } from 'express';
import { validate } from '../../common/validate';
import type { ProductsController } from './products.controller';
import {
  createProductBody,
  listProductsQuery,
  productParams,
  restockBody,
  updateProductBody,
} from './products.schemas';

/** Mounted at /products. Reads are public; writes need the admin key. */
export function productsRoutes(
  controller: ProductsController,
  requireAdmin: RequestHandler,
): Router {
  const router = Router();
  router.get('/', validate({ query: listProductsQuery }), controller.list);
  router.get('/:productId', validate({ params: productParams }), controller.get);
  router.post('/', requireAdmin, validate({ body: createProductBody }), controller.create);
  router.patch(
    '/:productId',
    requireAdmin,
    validate({ params: productParams, body: updateProductBody }),
    controller.update,
  );
  router.post(
    '/:productId/restock',
    requireAdmin,
    validate({ params: productParams, body: restockBody }),
    controller.restock,
  );
  return router;
}
