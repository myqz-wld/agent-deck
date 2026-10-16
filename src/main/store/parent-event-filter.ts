/** Filter before LIMIT so native work cannot evict parent conversation activity. */
export const PARENT_EVENT_FILTER = `kind != 'native-work-detail' AND (kind != 'background-task' OR
  CASE WHEN json_valid(payload_json) THEN json_type(payload_json, '$.native') IS NOT 'object' ELSE 1 END)`;
