import type Database from 'better-sqlite3';
import type { FeishuChatContext, FeishuSubscriptionRecord } from '@gateways/im';

/** Stores only conversation identity and source metadata, never chat contents. */
export class SqliteFeishuContextStore {
  constructor(private readonly db: Database.Database) {}

  getContext(instanceId: string, credentialId: string, chatId: string): FeishuChatContext | null {
    const row = this.db.prepare(`
      SELECT * FROM contexts WHERE instance_id = ? AND credential_id = ? AND chat_id = ?
    `).get(instanceId, credentialId, chatId) as Record<string, unknown> | undefined;
    return row ? {
      instanceId: row.instance_id as string,
      credentialId: row.credential_id as string,
      chatId: row.chat_id as string,
      chatType: row.chat_type as FeishuChatContext['chatType'],
      openId: row.open_id as string,
      activeSessionId: row.active_session_id as string | null,
      assistantSessionId: row.assistant_session_id as string | null,
      assistantGeneration: row.assistant_generation as number,
      updatedAt: row.updated_at as number,
    } : null;
  }

  listContexts(): readonly FeishuChatContext[] {
    return (this.db.prepare(`SELECT * FROM contexts ORDER BY credential_id, chat_id`).all() as
      Record<string, unknown>[]).map((row) => ({
      instanceId: row.instance_id as string,
      credentialId: row.credential_id as string,
      chatId: row.chat_id as string,
      chatType: row.chat_type as FeishuChatContext['chatType'],
      openId: row.open_id as string,
      activeSessionId: row.active_session_id as string | null,
      assistantSessionId: row.assistant_session_id as string | null,
      assistantGeneration: row.assistant_generation as number,
      updatedAt: row.updated_at as number,
    }));
  }

  putContext(value: FeishuChatContext): void {
    this.db.transaction(() => {
    const previous = this.getContext(value.instanceId, value.credentialId, value.chatId);
    if (previous?.assistantSessionId && previous.assistantSessionId !== value.assistantSessionId) {
      this.db.prepare(`UPDATE subscriptions SET status = 'inactive', updated_at = ?
        WHERE instance_id = ? AND credential_id = ? AND chat_id = ? AND session_id = ?`)
        .run(value.updatedAt, value.instanceId, value.credentialId, value.chatId, previous.assistantSessionId);
    }
    this.db.prepare(`
      INSERT INTO contexts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(instance_id, credential_id, chat_id) DO UPDATE SET
        open_id = excluded.open_id,
        active_session_id = excluded.active_session_id,
        updated_at = excluded.updated_at,
        chat_type = excluded.chat_type,
        assistant_session_id = excluded.assistant_session_id,
        assistant_generation = excluded.assistant_generation
    `).run(
      value.instanceId, value.credentialId, value.chatId, value.openId,
      value.activeSessionId, value.updatedAt, value.chatType, value.assistantSessionId, value.assistantGeneration,
    );
    }).immediate();
  }

  getSubscription(
    instanceId: string,
    credentialId: string,
    chatId: string,
    sessionId: string,
  ): FeishuSubscriptionRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM subscriptions
      WHERE instance_id = ? AND credential_id = ? AND chat_id = ? AND session_id = ?
    `).get(instanceId, credentialId, chatId, sessionId) as Record<string, unknown> | undefined;
    return row ? this.toSubscription(row) : null;
  }

  listSubscriptions(
    instanceId: string,
    credentialId: string,
    chatId: string,
  ): readonly FeishuSubscriptionRecord[] {
    return (this.db.prepare(`
      SELECT * FROM subscriptions
      WHERE instance_id = ? AND credential_id = ? AND chat_id = ? ORDER BY session_id
    `).all(instanceId, credentialId, chatId) as Record<string, unknown>[])
      .map((row) => this.toSubscription(row));
  }

  private toSubscription(row: Record<string, unknown>): FeishuSubscriptionRecord {
    return {
      instanceId: row.instance_id as string,
      credentialId: row.credential_id as string,
      chatId: row.chat_id as string,
      sessionId: row.session_id as string,
      status: row.status as FeishuSubscriptionRecord['status'],
      purpose: row.purpose as FeishuSubscriptionRecord['purpose'],
      updatedAt: row.updated_at as number,
    };
  }

  putSubscription(value: FeishuSubscriptionRecord): void {
    this.db.prepare(`
      INSERT INTO subscriptions VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(instance_id, credential_id, chat_id, session_id) DO UPDATE SET
        status = excluded.status, updated_at = excluded.updated_at, purpose = excluded.purpose
    `).run(
      value.instanceId, value.credentialId, value.chatId,
      value.sessionId, value.status, value.updatedAt, value.purpose,
    );
  }

}
