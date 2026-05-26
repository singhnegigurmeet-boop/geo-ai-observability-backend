import { NextFunction, Request, RequestHandler, Response } from "express";
import type { ApiResult } from "../types/api-response.types.js";
import { sendApiResult } from "../utils/api-response.js";

type MaybePromise<T> = T | Promise<T>;

export abstract class BaseRouter {
  protected asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => MaybePromise<void>): RequestHandler {
    return (req: Request, res: Response, next: NextFunction): void => {
      Promise.resolve(fn(req, res, next)).catch(next);
    };
  }

  protected apiHandler(
    fn: (req: Request, res: Response, next: NextFunction) => MaybePromise<ApiResult>
  ): RequestHandler {
    return (req: Request, res: Response, next: NextFunction): void => {
      Promise.resolve(fn(req, res, next))
        .then((result) => sendApiResult(res, result))
        .catch(next);
    };
  }
}
