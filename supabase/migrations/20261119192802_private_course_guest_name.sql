ALTER TABLE impulse.attempts ADD COLUMN guest_name text CHECK (guest_name IS NULL OR char_length(guest_name) BETWEEN 2 AND 100);
