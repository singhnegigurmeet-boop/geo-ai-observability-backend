import { NextFunction, Request, Response } from "express";
import { ZodSchema } from "zod";

export abstract class BaseRouter {
  protected validateBody<T>(req: Request, schema: ZodSchema): T {
    return schema.parse(req.body) as T;
  }

  protected validateParams<T>(req: Request, schema: ZodSchema): T {
    return schema.parse(req.params) as T;
  }

  protected asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
    return (req: Request, res: Response, next: NextFunction): void => {
      fn(req, res, next).catch(next);
    };
  }

  protected logRequest(req: Request, data?: unknown): void {
    const message = `[Request] ${req.method} ${req.path} from ${this.getClientIp(req)}`;
    if (data !== undefined) {
      console.log(message, data);
      return;
    }

    console.log(message);
  }

  protected logResponse(req: Request, statusCode: number, data?: unknown): void {
    const message = `[Response] ${req.method} ${req.path} - ${statusCode}`;
    if (data !== undefined) {
      console.log(message, data);
      return;
    }

    console.log(message);
  }

  protected getClientIp(req: Request): string {
    return (req.headers["x-forwarded-for"] as string)?.split(",")[0].trim() || req.socket.remoteAddress || "unknown";
  }
}
