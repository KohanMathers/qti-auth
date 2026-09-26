import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table kb_categories (
      id uuid primary key,
      slug text not null unique,
      name text not null,
      icon text,
      display_order integer not null,
      created_at timestamptz not null,
      updated_at timestamptz not null
    )
  `.execute(db);
  await sql`create index kb_categories_order_idx on kb_categories (display_order, name)`.execute(
    db,
  );
  await sql`
    create table kb_articles (
      id uuid primary key,
      category_id uuid not null references kb_categories (id),
      slug text not null unique,
      title text not null,
      body text not null,
      status text not null check (status in ('draft', 'published')),
      tags text[] not null,
      search_vector tsvector not null default ''::tsvector,
      published_at timestamptz,
      created_by uuid not null,
      updated_by uuid not null,
      created_at timestamptz not null,
      updated_at timestamptz not null
    )
  `.execute(db);
  await sql`create index kb_articles_category_idx on kb_articles (category_id, status)`.execute(db);
  await sql`create index kb_articles_published_idx on kb_articles (published_at desc, id desc)`.execute(
    db,
  );
  await sql`create index kb_articles_search_idx on kb_articles using gin (search_vector)`.execute(
    db,
  );
  await sql`
    create table kb_revisions (
      id uuid primary key,
      article_id uuid not null references kb_articles (id) on delete cascade,
      revision integer not null,
      title text not null,
      body text not null,
      tags text[] not null,
      slug text not null,
      category_id uuid not null,
      status text not null check (status in ('draft', 'published')),
      author_id uuid not null,
      created_at timestamptz not null,
      unique (article_id, revision)
    )
  `.execute(db);
  await sql`create index kb_revisions_article_idx on kb_revisions (article_id, revision desc)`.execute(
    db,
  );
  await sql`
    create table kb_images (
      id uuid primary key,
      object_key text not null,
      filename text not null,
      content_type text not null,
      size_bytes integer not null,
      created_by uuid not null,
      created_at timestamptz not null
    )
  `.execute(db);
  await sql`
    create table kb_feedback (
      article_id uuid not null references kb_articles (id) on delete cascade,
      session_id text not null,
      helpful boolean not null,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      primary key (article_id, session_id)
    )
  `.execute(db);
}
