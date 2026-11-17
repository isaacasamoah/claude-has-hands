# Tool reference

Generated from `native-host/src/tool-registry.ts` by `npm run docs:tools`. Do not edit by hand.
A trailing `?` marks an optional parameter. `GET /v1/tools` or `chh tools` returns the full JSON Schema for each tool.

| Tool | Summary | Parameters |
|------|---------|------------|
| `browser_status` | Check if the Chrome extension is connected and responsive. | none |
| `browser_navigate` | Navigate to a URL in the browser. | `url`, `tab?` |
| `browser_back` | Navigate back in browser history. | none |
| `browser_forward` | Navigate forward in browser history. | none |
| `browser_survey` | Get accessibility tree snapshot of interactive elements on the current page. | `includeAll?` |
| `browser_dom_snapshot` | Inspect DOM elements on the current page with selectors, XPath, bounding boxes, visibility, attributes, text, and bounded outerHTML. | `selector?`, `text?`, `limit?`, `includeHidden?`, `maxHtmlLength?` |
| `browser_click` | Click an element on the page. | `selector?`, `roleName?`, `index?` |
| `browser_type` | Type text into an element. | `selector?`, `roleName?`, `index?`, `text`, `clear?` |
| `browser_select_option` | Select an option in a native <select> element or ARIA combobox. | `selector?`, `roleName?`, `index?`, `value?`, `label?`, `optionIndex?` |
| `browser_read` | Extract text content from the current page or a specific element. | `selector?`, `maxLength?` |
| `browser_scroll` | Scroll the page or a specific scrollable element. | `direction`, `amount?`, `selector?` |
| `browser_keypress` | Dispatch a keyboard event (keydown, keypress, keyup) to the page or a specific element. | `key`, `selector?`, `modifiers?` |
| `browser_screenshot` | Capture a screenshot of the current page as a JPEG image. | `quality?` |
| `browser_observe` | Start or stop a DOM/navigation observer on the current page. | `action`, `observeId`, `events?` |
| `browser_tabs` | Manage browser tabs: list all tabs, switch to a tab, open a new tab, or close a tab. | `action`, `tabId?`, `url?` |
| `browser_wait` | Wait for a condition: page navigation to complete, a CSS selector to appear, or a fixed timeout. | `condition`, `selector?`, `timeout?` |
| `browser_console` | Read buffered console output (log/info/warn/error/debug) plus uncaught errors and unhandled promise rejections from the current page. | `level?`, `limit?`, `clear?` |
| `browser_network` | Read buffered network request metadata (method, URL, status, timing) for fetch() and XMLHttpRequest calls made by the current page. | `url?`, `method?`, `status?`, `limit?`, `clear?` |
| `browser_eval` | Evaluate a JavaScript expression in the page's main world and return its value. | `expression`, `awaitPromise?` |
| `browser_file_upload` | Attach local files to a file <input> on the page, targeted by CSS selector. | `selector`, `files` |
| `browser_form_input` | Fill multiple form fields in one call, targeting each by CSS selector. | `fields` |
| `browser_gif` | Capture a timed sequence of frames (screenshots) over a duration — useful for seeing animation, loading, or motion over a window. | `duration?`, `fps?`, `maxFrames?`, `quality?` |
| `browser_batch` | Run several browser_* tool calls in one request, in order, stopping at the first failure. | `steps` |
