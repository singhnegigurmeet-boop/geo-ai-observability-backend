CREATE INDEX outbox_events_stale_publishing_idx
  ON outbox_events (locked_at, outbox_event_id)
  WHERE status = 'publishing';
