import type {
  AnonymousSessionRow,
  JsonObject,
  UserRow,
  UserSessionRow
} from "../types/database.types.js";

export type CreatedSession<TSession> = {
  session: TSession;
  token: string;
};

export type UserSessionIdentity = {
  session: UserSessionRow;
  user: UserRow;
};

export type CreateAnonymousSessionInput = {
  clientMetadata?: JsonObject;
};

export type CreateUserSessionInput = {
  userId: string;
  clientMetadata?: JsonObject;
};

export type ResolvedAnonymousSession = AnonymousSessionRow;
