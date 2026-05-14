import { NextFunction, Request, Response } from "express";

export abstract class BaseRouter {
  protected asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
    return (req: Request, res: Response, next: NextFunction): void => {
      fn(req, res, next).catch(next);
    };
  }
}
