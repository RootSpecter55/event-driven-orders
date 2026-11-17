import type { Request, Response } from 'express';
import { sendPage } from '../../common/response';
import type { ListReservationsQuery } from './inventory.schemas';
import type { InventoryService } from './inventory.service';

export class InventoryController {
  constructor(private readonly service: InventoryService) {}

  listReservations = async (req: Request, res: Response) => {
    sendPage(res, await this.service.list(req.validated.query as ListReservationsQuery));
  };
}
