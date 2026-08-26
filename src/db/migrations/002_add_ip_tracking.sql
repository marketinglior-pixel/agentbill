-- Migration 002: Add IP tracking to API keys
ALTER TABLE developer_api_keys
  ADD COLUMN IF NOT EXISTS last_seen_ip VARCHAR(45) DEFAULT NULL;
