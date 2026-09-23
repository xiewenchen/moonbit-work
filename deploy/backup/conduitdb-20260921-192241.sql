--
-- PostgreSQL database dump
--

\restrict a2oEnix27DZyKxin6wW6I1h2udC7GsmgDoPoLvKEHZRqfofvDy27Hw6U0j4LdKT

-- Dumped from database version 16.15
-- Dumped by pg_dump version 16.15

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: article_tags; Type: TABLE; Schema: public; Owner: mbp
--

CREATE TABLE public.article_tags (
    article_id integer NOT NULL,
    tag_id integer NOT NULL
);


ALTER TABLE public.article_tags OWNER TO mbp;

--
-- Name: articles; Type: TABLE; Schema: public; Owner: mbp
--

CREATE TABLE public.articles (
    id integer NOT NULL,
    slug text NOT NULL,
    title text NOT NULL,
    description text NOT NULL,
    body text NOT NULL,
    author_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.articles OWNER TO mbp;

--
-- Name: articles_id_seq; Type: SEQUENCE; Schema: public; Owner: mbp
--

CREATE SEQUENCE public.articles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.articles_id_seq OWNER TO mbp;

--
-- Name: articles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: mbp
--

ALTER SEQUENCE public.articles_id_seq OWNED BY public.articles.id;


--
-- Name: comments; Type: TABLE; Schema: public; Owner: mbp
--

CREATE TABLE public.comments (
    id integer NOT NULL,
    article_id integer NOT NULL,
    author_id integer NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.comments OWNER TO mbp;

--
-- Name: comments_id_seq; Type: SEQUENCE; Schema: public; Owner: mbp
--

CREATE SEQUENCE public.comments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.comments_id_seq OWNER TO mbp;

--
-- Name: comments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: mbp
--

ALTER SEQUENCE public.comments_id_seq OWNED BY public.comments.id;


--
-- Name: favorites; Type: TABLE; Schema: public; Owner: mbp
--

CREATE TABLE public.favorites (
    user_id integer NOT NULL,
    article_id integer NOT NULL
);


ALTER TABLE public.favorites OWNER TO mbp;

--
-- Name: follows; Type: TABLE; Schema: public; Owner: mbp
--

CREATE TABLE public.follows (
    follower_id integer NOT NULL,
    following_id integer NOT NULL
);


ALTER TABLE public.follows OWNER TO mbp;

--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: mbp
--

CREATE TABLE public.schema_migrations (
    version text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.schema_migrations OWNER TO mbp;

--
-- Name: tags; Type: TABLE; Schema: public; Owner: mbp
--

CREATE TABLE public.tags (
    id integer NOT NULL,
    name text NOT NULL
);


ALTER TABLE public.tags OWNER TO mbp;

--
-- Name: tags_id_seq; Type: SEQUENCE; Schema: public; Owner: mbp
--

CREATE SEQUENCE public.tags_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.tags_id_seq OWNER TO mbp;

--
-- Name: tags_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: mbp
--

ALTER SEQUENCE public.tags_id_seq OWNED BY public.tags.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: mbp
--

CREATE TABLE public.users (
    id integer NOT NULL,
    email text NOT NULL,
    username text NOT NULL,
    password_hash text NOT NULL,
    bio text,
    image text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.users OWNER TO mbp;

--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: mbp
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.users_id_seq OWNER TO mbp;

--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: mbp
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: articles id; Type: DEFAULT; Schema: public; Owner: mbp
--

ALTER TABLE ONLY public.articles ALTER COLUMN id SET DEFAULT nextval('public.articles_id_seq'::regclass);


--
-- Name: comments id; Type: DEFAULT; Schema: public; Owner: mbp
--

ALTER TABLE ONLY public.comments ALTER COLUMN id SET DEFAULT nextval('public.comments_id_seq'::regclass);


--
-- Name: tags id; Type: DEFAULT; Schema: public; Owner: mbp
--

ALTER TABLE ONLY public.tags ALTER COLUMN id SET DEFAULT nextval('public.tags_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: mbp
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Data for Name: article_tags; Type: TABLE DATA; Schema: public; Owner: mbp
--

COPY public.article_tags (article_id, tag_id) FROM stdin;
\.


--
-- Data for Name: articles; Type: TABLE DATA; Schema: public; Owner: mbp
--

COPY public.articles (id, slug, title, description, body, author_id, created_at, updated_at) FROM stdin;
2	hello-world-1bs2d2	Hello World	dup	b	4	2026-09-21 08:32:52.07143+00	2026-09-21 08:32:52.07143+00
4	hello-world-q42d7x	Hello World	dup	b	7	2026-09-21 08:33:11.869405+00	2026-09-21 08:33:11.869405+00
6	hello-world-1i5ysf	Hello World	dup	b	10	2026-09-21 08:33:21.822911+00	2026-09-21 08:33:21.822911+00
8	hello-world-1gw5c5	Hello World	dup	b	13	2026-09-21 08:36:33.335176+00	2026-09-21 08:36:33.335176+00
10	hello-world-1vfxuy	Hello World	dup	b	19	2026-09-21 09:27:31.150913+00	2026-09-21 09:27:31.150913+00
12	hello-world-nhxh5e	Hello World	dup	b	24	2026-09-21 09:36:57.020224+00	2026-09-21 09:36:57.020224+00
\.


--
-- Data for Name: comments; Type: TABLE DATA; Schema: public; Owner: mbp
--

COPY public.comments (id, article_id, author_id, body, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: favorites; Type: TABLE DATA; Schema: public; Owner: mbp
--

COPY public.favorites (user_id, article_id) FROM stdin;
\.


--
-- Data for Name: follows; Type: TABLE DATA; Schema: public; Owner: mbp
--

COPY public.follows (follower_id, following_id) FROM stdin;
\.


--
-- Data for Name: schema_migrations; Type: TABLE DATA; Schema: public; Owner: mbp
--

COPY public.schema_migrations (version, applied_at) FROM stdin;
0001_conduit.sql	2026-09-21 08:32:13.490941+00
\.


--
-- Data for Name: tags; Type: TABLE DATA; Schema: public; Owner: mbp
--

COPY public.tags (id, name) FROM stdin;
1	test
2	moonbit
5	t979601108
7	t979793027
9	t982850670
11	t983416595
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: mbp
--

COPY public.users (id, email, username, password_hash, bio, image, created_at, updated_at) FROM stdin;
1	t1789979533661@example.com	t1789979533661	$2b$06$C2XHVm.bC6NbBvoU26D5WOFdPn/meNHgyBf9rVb./WwYsVI.ZW.XW	\N	\N	2026-09-21 08:32:13.724124+00	2026-09-21 08:32:13.724124+00
2	alice979571268@example.com	alice979571268	$2b$06$6pMek4reYzsRKJKUehxkUes4zyJJxhZwbZnh1DfcrApwj.mQSrir6	hello bio	http://img/x.png	2026-09-21 08:32:51.431051+00	2026-09-21 08:32:51.836161+00
4	bob979571268@example.com	bob979571268	$2b$06$XssAOoQMbjY6l7m4ahlrBeYXuVLC1Yk1fioe2KONTqbv6b0NgQCS.	\N	\N	2026-09-21 08:32:51.932475+00	2026-09-21 08:32:51.932475+00
5	alice979591236@example.com	alice979591236	$2b$06$imBWTF55iA6GHafxt8VWXO6YkXRGw0CYHe0A/VQV7Z40mtvHgYoeq	hello bio	http://img/x.png	2026-09-21 08:33:11.366564+00	2026-09-21 08:33:11.621933+00
7	bob979591236@example.com	bob979591236	$2b$06$9FB.SUgAIOp.2MFnbxBRXusubcjcq2hOm4IxzaXziF2u4CewFsIRW	\N	\N	2026-09-21 08:33:11.696451+00	2026-09-21 08:33:11.696451+00
8	alice979601108@example.com	alice979601108	$2b$06$xBALypyReUkZoB8BlQlKWuGpovWNRo7O75lI1Qink5lam5S6fve4O	hello bio	http://img/x.png	2026-09-21 08:33:21.260893+00	2026-09-21 08:33:21.604973+00
10	bob979601108@example.com	bob979601108	$2b$06$BPxbsU4K6nevDsI2b.xj9.JolhCKFbW8j349myPQowU9wL6uQ0sZW	\N	\N	2026-09-21 08:33:21.696735+00	2026-09-21 08:33:21.696735+00
11	alice979793027@example.com	alice979793027	$2b$06$ddjY3M9ZmYwpHxBc5HWkK.SOWFdKlD7De.dTcdWQ.4MKqSELwxPxW	hello bio	http://img/x.png	2026-09-21 08:36:33.099823+00	2026-09-21 08:36:33.206018+00
13	bob979793027@example.com	bob979793027	$2b$06$d0Z/U.0M5bm76ePbL/PSz.sT23fm36VUWLLi9ZkbkOAJafGlfPnkm	\N	\N	2026-09-21 08:36:33.228291+00	2026-09-21 08:36:33.228291+00
14	t1789979856921@example.com	t1789979856921	$2b$06$CvOa22bAGzNoTLEaWEWIf.1XMch6Vr4mwU706OfWelm3c4br7.5QS	\N	\N	2026-09-21 08:37:36.992411+00	2026-09-21 08:37:36.992411+00
15	t1789982805678@example.com	t1789982805678	$2b$06$Ej7h1.BbPwlSabj5vOXwMud7VELb7VBWQw1znxfQdsulU2OGgTJ6u	\N	\N	2026-09-21 09:26:45.73388+00	2026-09-21 09:26:45.73388+00
16	t1789982814846@example.com	t1789982814846	$2b$06$YOFzFG1VGn6uzxhp5ACtbOfKJrOe4KhARjURJPY6czJjlkX9VrrHe	\N	\N	2026-09-21 09:26:54.909942+00	2026-09-21 09:26:54.909942+00
17	alice982850670@example.com	alice982850670	$2b$06$Hhanh3ZSXUOMB4IGabIxeu2WveloQ.ieRvuo1rw5v8f3R0BPVPxX2	hello bio	http://img/x.png	2026-09-21 09:27:30.717479+00	2026-09-21 09:27:30.925195+00
19	bob982850670@example.com	bob982850670	$2b$06$ondwen6cFEaTayDUhmfyBeigJXLRDVzo6J0MO1i.a0YnxcS0UMRfu	\N	\N	2026-09-21 09:27:30.951563+00	2026-09-21 09:27:30.951563+00
20	bc983215073@example.com	bc983215073	$2b$06$IJh7USMmBer38Zo7r.vZcePw3WE9o2JY0R/CCP/CEggFEwjeGMIju	\N	\N	2026-09-21 09:33:35.132018+00	2026-09-21 09:33:35.132018+00
21	t1789983266893@example.com	t1789983266893	$2b$04$eUR3o17xD0/HknrWi6eeUuebd7aKLnYFPe9zrYOWSQZklgZvatxR6	\N	\N	2026-09-21 09:34:26.909635+00	2026-09-21 09:34:26.909635+00
22	alice983416595@example.com	alice983416595	$2b$06$1i0/F/ZjSgtO7QUrhVM44OhwwJXtlZu4j3CyNj50Xn8AJV7bzOrOq	hello bio	http://img/x.png	2026-09-21 09:36:56.641453+00	2026-09-21 09:36:56.816072+00
24	bob983416595@example.com	bob983416595	$2b$06$IUYb6KEr.OtxpMD7Z2cYNOVq2WxnxwacgMTQhJ3tDy0q8njTttpX6	\N	\N	2026-09-21 09:36:56.840696+00	2026-09-21 09:36:56.840696+00
25	t1789983437691@example.com	t1789983437691	$2b$04$KLQZjmMTjPEPcqD5BI5fT.K4s4zPzaCOi2U0rUGx4jjxazVm2Z5K2	\N	\N	2026-09-21 09:37:17.709169+00	2026-09-21 09:37:17.709169+00
26	t1789989640059@example.com	t1789989640059	$2b$04$JdtLN6nZiW8reglHDHvd7.2ltnAKSukpHUMZAKwOQFUWjhbLKZz5C	\N	\N	2026-09-21 11:20:40.07776+00	2026-09-21 11:20:40.07776+00
\.


--
-- Name: articles_id_seq; Type: SEQUENCE SET; Schema: public; Owner: mbp
--

SELECT pg_catalog.setval('public.articles_id_seq', 12, true);


--
-- Name: comments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: mbp
--

SELECT pg_catalog.setval('public.comments_id_seq', 6, true);


--
-- Name: tags_id_seq; Type: SEQUENCE SET; Schema: public; Owner: mbp
--

SELECT pg_catalog.setval('public.tags_id_seq', 12, true);


--
-- Name: users_id_seq; Type: SEQUENCE SET; Schema: public; Owner: mbp
--

SELECT pg_catalog.setval('public.users_id_seq', 26, true);


--
-- Name: article_tags article_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: mbp
--

ALTER TABLE ONLY public.article_tags
    ADD CONSTRAINT article_tags_pkey PRIMARY KEY (article_id, tag_id);


--
-- Name: articles articles_pkey; Type: CONSTRAINT; Schema: public; Owner: mbp
--

ALTER TABLE ONLY public.articles
    ADD CONSTRAINT articles_pkey PRIMARY KEY (id);


--
-- Name: articles articles_slug_key; Type: CONSTRAINT; Schema: public; Owner: mbp
--

ALTER TABLE ONLY public.articles
    ADD CONSTRAINT articles_slug_key UNIQUE (slug);


--
-- Name: comments comments_pkey; Type: CONSTRAINT; Schema: public; Owner: mbp
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_pkey PRIMARY KEY (id);


--
-- Name: favorites favorites_pkey; Type: CONSTRAINT; Schema: public; Owner: mbp
--

ALTER TABLE ONLY public.favorites
    ADD CONSTRAINT favorites_pkey PRIMARY KEY (user_id, article_id);


--
-- Name: follows follows_pkey; Type: CONSTRAINT; Schema: public; Owner: mbp
--

ALTER TABLE ONLY public.follows
    ADD CONSTRAINT follows_pkey PRIMARY KEY (follower_id, following_id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: mbp
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: tags tags_name_key; Type: CONSTRAINT; Schema: public; Owner: mbp
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_name_key UNIQUE (name);


--
-- Name: tags tags_pkey; Type: CONSTRAINT; Schema: public; Owner: mbp
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_pkey PRIMARY KEY (id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: mbp
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: mbp
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_username_key; Type: CONSTRAINT; Schema: public; Owner: mbp
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);


--
-- Name: articles_author_idx; Type: INDEX; Schema: public; Owner: mbp
--

CREATE INDEX articles_author_idx ON public.articles USING btree (author_id);


--
-- Name: articles_created_idx; Type: INDEX; Schema: public; Owner: mbp
--

CREATE INDEX articles_created_idx ON public.articles USING btree (created_at DESC);


--
-- Name: comments_article_idx; Type: INDEX; Schema: public; Owner: mbp
--

CREATE INDEX comments_article_idx ON public.comments USING btree (article_id);


--
-- Name: article_tags article_tags_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: mbp
--

ALTER TABLE ONLY public.article_tags
    ADD CONSTRAINT article_tags_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


--
-- Name: article_tags article_tags_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: mbp
--

ALTER TABLE ONLY public.article_tags
    ADD CONSTRAINT article_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON DELETE CASCADE;


--
-- Name: articles articles_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: mbp
--

ALTER TABLE ONLY public.articles
    ADD CONSTRAINT articles_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: comments comments_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: mbp
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


--
-- Name: comments comments_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: mbp
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: favorites favorites_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: mbp
--

ALTER TABLE ONLY public.favorites
    ADD CONSTRAINT favorites_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


--
-- Name: favorites favorites_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: mbp
--

ALTER TABLE ONLY public.favorites
    ADD CONSTRAINT favorites_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: follows follows_follower_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: mbp
--

ALTER TABLE ONLY public.follows
    ADD CONSTRAINT follows_follower_id_fkey FOREIGN KEY (follower_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: follows follows_following_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: mbp
--

ALTER TABLE ONLY public.follows
    ADD CONSTRAINT follows_following_id_fkey FOREIGN KEY (following_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict a2oEnix27DZyKxin6wW6I1h2udC7GsmgDoPoLvKEHZRqfofvDy27Hw6U0j4LdKT

