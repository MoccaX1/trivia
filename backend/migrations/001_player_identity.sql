CREATE TABLE player (
  id UUID PRIMARY KEY,
  display_name TEXT NOT NULL
);

CREATE TABLE password_credential (
  player_id UUID PRIMARY KEY REFERENCES player(id),
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL
);
