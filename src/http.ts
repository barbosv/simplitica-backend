/** The route contract shared by Node and the fetch-native Worker adapters. */
export type ApiRequest = {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  params: unknown;
  query: unknown;
  ip: string;
  rawBody?: Buffer;
  simplilistDeviceId?: string;
  log: {
    error(info: unknown, message?: string): void;
    warn(info: unknown, message?: string): void;
  };
};
export type ApiReply = {
  code(status: number): ApiReply;
  type(contentType: string): ApiReply;
  send(body: unknown): unknown;
};
export type ApiHandler = (
  request: ApiRequest,
  reply: ApiReply,
) => unknown | Promise<unknown>;
export type ApiHook = (
  request: ApiRequest,
  reply: ApiReply,
) => Promise<unknown>;
export type ApiRouteOptions = {
  onRequest?: ApiHook[];
  config?: { rawBody?: boolean };
};
export type ApiRouter = {
  get(path: string, handler: ApiHandler): unknown;
  get(path: string, options: ApiRouteOptions, handler: ApiHandler): unknown;
  post(path: string, handler: ApiHandler): unknown;
  post(path: string, options: ApiRouteOptions, handler: ApiHandler): unknown;
};
