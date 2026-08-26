-- Migration 003: Add key expiration support
ALTER TABLE developer_api_keys
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;
