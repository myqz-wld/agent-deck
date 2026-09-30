/** Presentation only; command syntax and provider-native values remain unchanged. */
export const FEISHU_FIELD_LABELS: Readonly<Record<string, string>> = {
  subject: '标题', description: '内容', command: '命令', cwd: '工作目录', workingDirectory: '工作目录',
  path: '路径', file_path: '文件', sessionId: '目标会话', adapter: '助手类型', adapterId: '助手类型',
  model: '模型', thinking: '思考程度', title: '会话名称', initialMessage: '首条任务',
  selection: '模型与运行设置', preference: '保存的设置', purpose: '应用范围', provider: '模型网关',
  permissionMode: '审批模式', approvalPolicy: '审批模式', sessionMode: '运行模式',
  claudeCodeSandbox: '沙盒', codexSandbox: '沙盒', grokSandbox: '沙盒',
  expectedTitle: '原会话名称', taskId: '待办 ID', status: '状态', content: '内容',
};

const VALUES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  adapterId: { 'codex-cli': 'Codex', 'claude-code': 'Claude', 'grok-build': 'Grok' },
  purpose: { conversation: '机器人聊天', session: '新建工作会话' },
  approvalPolicy: { 'on-request': '按需审批', untrusted: '不受信任时审批', never: '不再询问' },
  permissionMode: { default: '手动确认', acceptEdits: '自动接受文件编辑', plan: '计划模式', auto: '自动判断', bypassPermissions: '不再询问' },
  sessionMode: { default: '默认模式', plan: '计划模式', ask: '询问模式' },
  codexSandbox: { 'workspace-write': '工作区写入', 'read-only': '只读', 'danger-full-access': '不限制' },
  claudeCodeSandbox: { off: '关闭', 'workspace-write': '工作区写入', strict: '严格' },
  grokSandbox: { off: '关闭', workspace: '工作区写入', 'read-only': '只读' },
  status: { active: '进行中', idle: '空闲', running: '处理中', finished: '已完成',
    'active-idle': '空闲', 'active-running': '处理中', 'active-finished': '已完成', 'active-waiting': '等待确认',
    dormant: '休眠', closed: '已关闭', failed: '失败', pending: '待处理', completed: '已完成',
    blocked: '受阻', abandoned: '已放弃' },
  role: { user: '你', assistant: '助手', system: '系统', tool: '工具' },
  effect: { 'hot-applied': '已生效', 'restart-required': '需要重新启动会话', 'handoff-required': '需要续接到新会话' },
};

export function feishuDisplayValue(key: string, value: string): string {
  return VALUES[key]?.[value] ?? value;
}

export function feishuCallbackToast(code: string, duplicate: boolean): string {
  if (duplicate) return '该事件已处理。';
  const labels: Record<string, string> = {
    accepted: '已接受。', already_decided: '该审批已结束，无需再次操作。',
    pending_context_changed: '审批内容已变化，请刷新待确认事项后重新确认。',
    invalid_nonce: '这张审批卡已过期或无效，请刷新待确认事项。',
    conflict: '状态刚刚发生变化，请刷新待确认事项后重试。',
    access_denied: '当前账号无权执行此操作。', revoked: '连接授权已失效，请在 Agent Deck 中检查。',
    invalid_pending_action: '此审批操作已不可用，请刷新待确认事项。',
    invalid_event: '无法识别这次操作，请刷新后重试。', unknown_command: '无法识别这个命令，请发送 /help 查看用法。',
    input_too_large: '消息过长，请分成几条发送。', not_found: '没有找到对应的会话或请求。',
    reconciliation_required: '上次操作的结果尚未确认，请先查看当前状态。',
    delivery_exhausted: '这次回复未能送达，请查看当前会话状态。',
  };
  return labels[code] ?? '暂时无法完成这次操作，请稍后重试。';
}
