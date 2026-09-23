-- RealWorld Conduit 数据模型
CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY,
  email text NOT NULL UNIQUE,
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  bio text,
  image text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS articles (
  id serial PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  title text NOT NULL,
  description text NOT NULL,
  body text NOT NULL,
  author_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS articles_author_idx ON articles (author_id);
CREATE INDEX IF NOT EXISTS articles_created_idx ON articles (created_at DESC);

CREATE TABLE IF NOT EXISTS tags (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS article_tags (
  article_id integer NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  tag_id integer NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (article_id, tag_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id serial PRIMARY KEY,
  article_id integer NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  author_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS comments_article_idx ON comments (article_id);

CREATE TABLE IF NOT EXISTS favorites (
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  article_id integer NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, article_id)
);

CREATE TABLE IF NOT EXISTS follows (
  follower_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (follower_id, following_id)
);
