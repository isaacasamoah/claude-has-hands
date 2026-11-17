/** Command message sent from MCP server to native host, relayed to extension */
export interface CommandMessage {
  id: string;
  action: string;
  params: Record<string, unknown>;
}

/** Response message from extension, relayed back to MCP server */
export interface ResponseMessage {
  id: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

/** Event message pushed from extension (unsolicited) */
export interface EventMessage {
  type: "observe_event";
  observe_id: string;
  event: string;
  data: Record<string, unknown>;
}
