/* global AbortSignal, fetch, Buffer, Headers, Request, Response, module */
// node-fetch v2 surface used by Apple's SDK, backed by Workers' native fetch.
async function nodeFetch(input, init = {}) {
  const { timeout = 30000, ...options } = init;
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)])
    : AbortSignal.timeout(timeout);
  const response = await fetch(input, { ...options, signal });
  return Object.assign(response, {
    async buffer() {
      return Buffer.from(await response.arrayBuffer());
    },
  });
}
module.exports = nodeFetch;
module.exports.default = nodeFetch;
module.exports.Headers = Headers;
module.exports.Request = Request;
module.exports.Response = Response;
