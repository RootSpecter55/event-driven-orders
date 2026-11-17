import type { Request, Response } from 'express';
import { sendData, sendPage } from '../../common/response';
import type { DeadLetterParams, ListDeadLettersQuery, ListOutboxQuery } from './events.schemas';
import type { EventsService } from './events.service';

export class EventsController {
  constructor(private readonly service: EventsService) {}

  listOutbox = async (req: Request, res: Response) => {
    sendPage(res, await this.service.listOutbox(req.validated.query as ListOutboxQuery));
  };

  listDeadLetters = async (req: Request, res: Response) => {
    const query = req.validated.query as ListDeadLettersQuery;
    sendPage(res, await this.service.listDeadLetters(query));
  };

  redrive = async (req: Request, res: Response) => {
    const { deadLetterId } = req.validated.params as DeadLetterParams;
    sendData(res, await this.service.redrive(deadLetterId), 202);
  };
}
