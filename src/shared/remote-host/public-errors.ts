export const REMOTE_HOST_PUBLIC_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  access_denied: '远程 Core 拒绝了此操作。',
  already_decided: '该待处理请求已经完成。',
  cancelled: '操作已取消。',
  capability_unavailable: '远程 Core 不支持此操作。',
  child_exit_timeout: '本机 SSH 退出状态不确定；为避免启动第二个传输，只能重启 Agent Deck 后恢复。',
  conflict: '远程数据已变化，请刷新后重试。',
  connection_closed: 'SSH 连接已关闭。',
  connection_failed: '无法建立 SSH 连接，请检查地址和凭据。',
  deadline_exceeded: '远程操作超时。',
  handshake_timeout: 'SSH 协议握手超时。',
  host_key_verification_failed: '服务器身份校验失败，请重新获取或核对连接凭证。',
  incompatible_handshake: '远程 Agent Deck 与当前桌面版本不兼容。',
  incompatible_protocol: '远程 Agent Deck 协议版本不兼容。',
  in_flight_limit: '远程请求过多，请稍后重试。',
  invalid_profile: 'SSH 配置无效。',
  invalid_request: '远程操作参数无效。',
  not_connected: '请先连接远程主机。',
  not_found: '远程对象不存在或已删除。',
  protocol_violation: '远程返回不符合 Agent Deck 协议。',
  provider_lost: '远程 provider 已断开。',
  replay_gap: '远程事件流无法连续恢复，请重新连接。',
  revoked: '远程访问权限已撤销。',
  service_stopped: '远程主机服务已停止。',
  stale_scope: '当前主机或会话已切换，请重试。',
  'transport-close-failed': '本机 SSH 退出状态不确定；为避免启动第二个传输，只能重启 Agent Deck 后恢复。',
  worker_offline: '远程执行节点当前离线。',
  write_queue_limit: 'SSH 写入队列已满，请稍后重试。',
});

const DEFINITIVE_REJECTION_CODES = new Set([
  'access_denied',
  'already_decided',
  'capability_unavailable',
  'conflict',
  'handshake_timeout',
  'host_key_verification_failed',
  'incompatible_handshake',
  'incompatible_protocol',
  'in_flight_limit',
  'invalid_profile',
  'invalid_request',
  'not_connected',
  'not_found',
  'revoked',
  'write_queue_limit',
]);

export function safeRemoteHostErrorCode(code: string): string {
  return Object.prototype.hasOwnProperty.call(REMOTE_HOST_PUBLIC_MESSAGES, code)
    ? code
    : 'internal_error';
}

/** True only when Core/transport evidence proves the request was rejected before mutation. */
export function isDefinitiveRemoteHostRejection(error: unknown): boolean {
  const code = error && typeof error === 'object'
    ? (error as { code?: unknown }).code
    : undefined;
  if (typeof code === 'string' && DEFINITIVE_REJECTION_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return [...DEFINITIVE_REJECTION_CODES].some((candidate) => {
    const publicMessage = REMOTE_HOST_PUBLIC_MESSAGES[candidate];
    return publicMessage !== undefined && message.includes(publicMessage);
  });
}
