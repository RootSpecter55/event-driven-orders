import type { Request, Response } from 'express';
import { sendData, sendPage } from '../../common/response';
import type { ListOrdersQuery, OrderParams, PlaceOrderInput } from './orders.schemas';
import type { OrdersService } from './orders.service';

export class OrdersController {
  constructor(private readonly service: OrdersService) {}

  /** 202: the order is accepted; checkout finishes asynchronously. */
  place = async (req: Request, res: Response) => {
    sendData(res, await this.service.place(req.validated.body as PlaceOrderInput), 202);
  };

  get = async (req: Request, res: Response) => {
    const { orderId } = req.validated.params as OrderParams;
    sendData(res, await this.service.get(orderId));
  };

  list = async (req: Request, res: Response) => {
    sendPage(res, await this.service.list(req.validated.query as ListOrdersQuery));
  };
}
