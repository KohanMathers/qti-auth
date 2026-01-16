# Migration Instructions: Admin-Only Games

This migration adds the ability to mark games as admin-only, preventing normal users from seeing test games before you add real games.

## What Changed

1. **Database**: Added `admin_only` column to `games` table
2. **Backend**: Updated `/games` endpoint to filter games based on user role
3. **Backend**: Added permission check to `/games/:gameSlug/stats` endpoint
4. **Test Data**: Marked "QTI Test Game" as admin-only

## How to Apply the Migration

### For Local Development
```bash
wrangler d1 execute qti_auth --local --file=./migrations/0003_add_admin_only_to_games.sql
```

### For Production
```bash
wrangler d1 execute qti_auth --remote --file=./migrations/0003_add_admin_only_to_games.sql
```

## Expected Behavior

### Normal Users
- Will NOT see "QTI Test Game" in their stats page
- If they try to access `/stats/test-game` directly, they'll get a 403 Forbidden error
- Will see any future games that are NOT marked as admin-only

### Admin Users
- Will see ALL games including "QTI Test Game"
- Can access all game stats including admin-only games
- No change to their experience

## Testing

### Test as Normal User
1. Log in as a normal user
2. Navigate to `/stats`
3. Verify "QTI Test Game" does NOT appear
4. Try accessing `/stats/test-game` directly - should get error message

### Test as Admin
1. Log in as an admin user
2. Navigate to `/stats`
3. Verify "QTI Test Game" DOES appear
4. Can click and view all test achievements

## Adding Future Games

When you add real games, use `admin_only = 0` (or omit it, as 0 is the default):

```sql
INSERT INTO games (id, name, slug, description, icon_url, is_active, admin_only, created_at, updated_at)
VALUES (
  'game_real_12345',
  'My Real Game',
  'my-real-game',
  'A real game for all users',
  'https://example.com/icon.png',
  1,
  0,  -- Normal users can see this
  unixepoch(),
  unixepoch()
);
```

## Rollback (if needed)

If you need to revert this change:

```sql
-- Remove the column (WARNING: This will lose admin_only data)
ALTER TABLE games DROP COLUMN admin_only;
```

Note: SQLite doesn't support dropping columns in older versions. You may need to recreate the table if rollback is needed.
