CREATE TABLE IF NOT EXISTS notes (
  id serial PRIMARY KEY,
  title text NOT NULL,
  body text
);
