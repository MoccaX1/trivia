-- The runner owns the transaction and advisory lock. Block concurrent credential
-- writes while checking and canonicalizing; never merge existing accounts.
LOCK TABLE password_credential IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM password_credential
    GROUP BY translate(username, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'USERNAME_CANONICAL_COLLISION';
  END IF;
  IF EXISTS (
    SELECT 1 FROM password_credential
    WHERE octet_length(username) NOT BETWEEN 1 AND 128
      OR username COLLATE "C" !~ '^[A-Za-z0-9_.-]+$'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'USERNAME_INVALID_EXISTING';
  END IF;
END $$;
UPDATE password_credential
SET username = translate(username, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz');
ALTER TABLE password_credential ADD CONSTRAINT password_credential_username_canonical
  CHECK (octet_length(username) BETWEEN 1 AND 128
    AND username COLLATE "C" ~ '^[a-z0-9_.-]+$');
-- Existing UNIQUE(username) now enforces canonical, case-insensitive identity.
-- Display names remain TEXT: ICU grapheme validation belongs at application
-- boundaries, and no incompatible constraint is imposed on legacy records.
