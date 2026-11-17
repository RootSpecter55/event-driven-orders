import type { Request, Response } from 'express';
import { sendPage } from '../../common/response';
import type { ListPaymentsQuery } from './payments.schemas';
import type { PaymentsService } from './payments.service';

export class PaymentsController {
  constructor(private readonly service: PaymentsService) {}

  list = async (req: Request, res: Response) => {
    sendPage(res, await this.service.list(req.validated.query as ListPaymentsQuery));
  };
}
