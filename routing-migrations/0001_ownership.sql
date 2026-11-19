CREATE TABLE inbound_routing_ownership (
  kind TEXT NOT NULL CHECK (kind IN ('mailbox', 'catch_all')),
  route_key TEXT NOT NULL COLLATE NOCASE CHECK (length(route_key) > 0),
  environment TEXT NOT NULL CHECK (environment IN ('production', 'preview')),
  PRIMARY KEY (kind, route_key)
) STRICT;
