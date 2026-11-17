import type { Request, Response } from 'express';
import { sendData, sendPage } from '../../common/response';
import type {
  CreateProductInput,
  ListProductsQuery,
  ProductParams,
  RestockInput,
  UpdateProductInput,
} from './products.schemas';
import type { ProductsService } from './products.service';

export class ProductsController {
  constructor(private readonly service: ProductsService) {}

  create = async (req: Request, res: Response) => {
    sendData(res, await this.service.create(req.validated.body as CreateProductInput), 201);
  };

  list = async (req: Request, res: Response) => {
    sendPage(res, await this.service.list(req.validated.query as ListProductsQuery));
  };

  get = async (req: Request, res: Response) => {
    const { productId } = req.validated.params as ProductParams;
    sendData(res, await this.service.get(productId));
  };

  update = async (req: Request, res: Response) => {
    const { productId } = req.validated.params as ProductParams;
    sendData(res, await this.service.update(productId, req.validated.body as UpdateProductInput));
  };

  restock = async (req: Request, res: Response) => {
    const { productId } = req.validated.params as ProductParams;
    sendData(res, await this.service.restock(productId, req.validated.body as RestockInput));
  };
}
