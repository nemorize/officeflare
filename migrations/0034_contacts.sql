CREATE TABLE contact_books (
  id TEXT PRIMARY KEY NOT NULL,
  owner_user_id TEXT NOT NULL UNIQUE REFERENCES users (id),
  name TEXT NOT NULL DEFAULT 'Contacts',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
)
STRICT;

CREATE TABLE contact_folders (
  id TEXT PRIMARY KEY NOT NULL,
  book_id TEXT NOT NULL REFERENCES contact_books (id),
  parent_id TEXT,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  name_key TEXT NOT NULL CHECK (length(name_key) > 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (book_id, id),
  FOREIGN KEY (book_id, parent_id) REFERENCES contact_folders (book_id, id)
)
STRICT;
CREATE UNIQUE INDEX contact_folders_siblings ON contact_folders (book_id, parent_id, name_key)
WHERE parent_id IS NOT NULL;
CREATE UNIQUE INDEX contact_folders_roots ON contact_folders (book_id, name_key)
WHERE parent_id IS NULL;
CREATE TRIGGER contact_folder_cycle
BEFORE UPDATE OF parent_id ON contact_folders
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Contact folder cycle')
  WHERE
    NEW.parent_id IN
      (
        WITH RECURSIVE
          descendants(id) AS (
            SELECT OLD.id
            UNION
            SELECT f.id
            FROM contact_folders f
            JOIN descendants d ON f.parent_id = d.id
          )
        SELECT id
        FROM descendants
      );
END;
CREATE TRIGGER contact_folder_self_parent
BEFORE INSERT ON contact_folders
WHEN NEW.parent_id = NEW.id
BEGIN
  SELECT RAISE(ABORT, 'Contact folder cycle');
END;

CREATE TABLE contacts (
  id TEXT PRIMARY KEY NOT NULL,
  book_id TEXT NOT NULL REFERENCES contact_books (id),
  folder_id TEXT,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 255),
  display_name_key TEXT NOT NULL,
  given_name TEXT NOT NULL DEFAULT '',
  family_name TEXT NOT NULL DEFAULT '',
  nickname TEXT NOT NULL DEFAULT '',
  organization TEXT NOT NULL DEFAULT '',
  organization_key TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  job_title TEXT NOT NULL DEFAULT '',
  birthday TEXT,
  notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 10000),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  trashed_at INTEGER,
  UNIQUE (book_id, id),
  FOREIGN KEY (book_id, folder_id) REFERENCES contact_folders (book_id, id)
)
STRICT;
CREATE INDEX contacts_list ON contacts (book_id, display_name_key, id)
WHERE trashed_at IS NULL;
CREATE INDEX contacts_folder ON contacts (book_id, folder_id, display_name_key, id)
WHERE trashed_at IS NULL;
CREATE INDEX contacts_organization ON contacts (book_id, organization_key, id)
WHERE trashed_at IS NULL;
CREATE INDEX contacts_trash ON contacts (book_id, trashed_at, id);

CREATE TABLE contact_emails (
  id TEXT PRIMARY KEY NOT NULL,
  book_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  email_address TEXT NOT NULL CHECK (length(email_address) BETWEEN 3 AND 254),
  email_key TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (contact_id, email_key),
  FOREIGN KEY (book_id, contact_id) REFERENCES contacts (book_id, id)
    ON DELETE CASCADE
)
STRICT;
CREATE INDEX contact_emails_lookup ON contact_emails (book_id, email_key, contact_id);
CREATE UNIQUE INDEX contact_emails_primary ON contact_emails (contact_id) WHERE is_primary = 1;

CREATE TABLE contact_phones (
  id TEXT PRIMARY KEY NOT NULL,
  contact_id TEXT NOT NULL REFERENCES contacts (id)
    ON DELETE CASCADE,
  phone_number TEXT NOT NULL CHECK (length(phone_number) BETWEEN 1 AND 100),
  phone_key TEXT NOT NULL,
  extension TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0
)
STRICT;
CREATE INDEX contact_phones_contact ON contact_phones (contact_id, phone_key);
CREATE UNIQUE INDEX contact_phones_primary ON contact_phones (contact_id) WHERE is_primary = 1;

CREATE TABLE contact_addresses (
  id TEXT PRIMARY KEY NOT NULL,
  contact_id TEXT NOT NULL REFERENCES contacts (id)
    ON DELETE CASCADE,
  country_code TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  postal_code TEXT NOT NULL DEFAULT '',
  street_address TEXT NOT NULL DEFAULT '',
  extended_address TEXT NOT NULL DEFAULT '',
  formatted_address TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0
)
STRICT;
CREATE INDEX contact_addresses_contact ON contact_addresses (contact_id);
CREATE UNIQUE INDEX contact_addresses_primary ON contact_addresses (contact_id)
WHERE is_primary = 1;

CREATE TABLE contact_links (
  id TEXT PRIMARY KEY NOT NULL,
  contact_id TEXT NOT NULL REFERENCES contacts (id)
    ON DELETE CASCADE,
  url TEXT NOT NULL CHECK (length(url) BETWEEN 1 AND 2048),
  label TEXT NOT NULL DEFAULT '',
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0
)
STRICT;
CREATE INDEX contact_links_contact ON contact_links (contact_id);
CREATE UNIQUE INDEX contact_links_primary ON contact_links (contact_id) WHERE is_primary = 1;

CREATE TABLE contact_field_definitions (
  id TEXT PRIMARY KEY NOT NULL,
  book_id TEXT NOT NULL REFERENCES contact_books (id),
  key TEXT NOT NULL,
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 255),
  value_type TEXT NOT NULL CHECK (
    value_type IN ('text', 'number', 'boolean', 'date', 'url', 'select', 'multiselect')
  ),
  options_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(options_json)
    AND json_type(options_json) = 'array'
  ),
  sort_order INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  archived_at INTEGER,
  UNIQUE (book_id, id),
  UNIQUE (book_id, key)
)
STRICT;

CREATE TABLE contact_field_values (
  book_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  PRIMARY KEY (contact_id, field_id),
  FOREIGN KEY (book_id, contact_id) REFERENCES contacts (book_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (book_id, field_id) REFERENCES contact_field_definitions (book_id, id)
)
STRICT;
CREATE INDEX contact_field_values_definition ON contact_field_values (field_id, contact_id);

CREATE TABLE contact_operations (
  id TEXT PRIMARY KEY NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users (id),
  operation TEXT NOT NULL,
  idempotency_key TEXT,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  UNIQUE (actor_user_id, operation, idempotency_key)
)
STRICT;
CREATE INDEX contact_operations_expiration ON contact_operations (expires_at);
