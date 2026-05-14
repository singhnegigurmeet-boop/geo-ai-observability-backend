import { Request } from "express";

export abstract class BaseController {
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
