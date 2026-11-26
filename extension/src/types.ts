/** Command message from native host to extension */
export interface CommandMessage {
  /** Unique request ID for correlating responses */
  id: string;
  /** The action to perform */
  action:
    | "navigate"
    | "back"
    | "forward"
    | "survey"
    | "click"
    | "type"
    | "select_option"
    | "scroll"
    | "keypress"
    | "read"
    | "dom_snapshot"
    | "screenshot"
    | "observe"
    | "tabs"
    | "wait"
    | "status"
    | "read_console"
    | "read_network"
    | "eval"
    | "file_upload"
    | "form_input"
    | "gif";
  /** Action-specific parameters */
  params: Record<string, unknown>;
}

/** Response message from extension to native host */
export interface ResponseMessage {
  /** Matches the request ID */
  id: string;
  /** Whether the action succeeded */
  success: boolean;
  /** Action result (when success is true) */
  result?: unknown;
  /** Error message (when success is false) */
  error?: string;
}

/** Event message from extension to native host (unsolicited) */
export interface EventMessage {
  type: "observe_event";
  observe_id: string;
  event: "dom" | "navigation";
  data: Record<string, unknown>;
}

/** Tab registry entry */
export interface TabEntry {
  url: string;
  title: string;
  lastActive: number;
}
