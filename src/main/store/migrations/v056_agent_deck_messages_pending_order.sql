CREATE INDEX idx_messages_pending_sent_at
  ON agent_deck_messages(status, sent_at)
  WHERE status = 'pending';
