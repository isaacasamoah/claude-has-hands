import type { ResponseMessage } from "../types.js";

export const MAX_MESSAGE_BYTES = 950_000;

const encoder = new TextEncoder();

export function fitResponse(response: ResponseMessage): ResponseMessage {
  const bytes = encoder.encode(JSON.stringify(response)).length;
  if (bytes <= MAX_MESSAGE_BYTES) return response;
  return {
    id: response.id,
    success: false,
    error: `Response too large (${bytes} bytes). The limit is ${MAX_MESSAGE_BYTES} bytes.`,
  };
}
