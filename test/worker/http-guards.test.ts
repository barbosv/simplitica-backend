import { expect, it } from "vitest";
import { readBoundedBody } from "../../src/worker/http.js";

it("accepts the body-size boundary and rejects one byte above it without Content-Length", async () => {
  expect(
    (
      await readBoundedBody(
        new Request("https://test", {
          method: "POST",
          body: new Uint8Array(262144),
        }),
      )
    ).length,
  ).toBe(262144);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(131072));
      controller.enqueue(new Uint8Array(131073));
      controller.close();
    },
  });
  await expect(
    readBoundedBody(
      new Request("https://test", {
        method: "POST",
        body: stream,
        duplex: "half",
      } as RequestInit),
    ),
  ).rejects.toMatchObject({ status: 413 });
});
