# Game Stats & Achievements Setup

## Database Setup

### 1. Apply the migration

```bash
wrangler d1 migrations apply qti_auth --remote
```

This will create the following tables:
- `games` - Store game information
- `game_achievements` - Achievement definitions
- `user_achievements` - Unlocked achievements per user
- `user_game_stats` - Custom stats per user per game

### 2. Seed test game data

```bash
wrangler d1 execute qti_auth --remote --file=./schema-games.sql
```

This creates:
- **QTI Test Game** with 8 sample achievements
- Only visible to admin accounts for testing

## Features

### For Regular Users
- Shows "Coming Soon!" message when visiting `/stats`
- Will display games once they're released

### For Admin Users
- Can see the "QTI Test Game"
- View 8 test achievements (all locked by default)
- Test the achievements/stats UI

## Achievement System

### Achievement Structure
```sql
- id: Unique achievement identifier
- game_id: Reference to the game
- name: Achievement name
- description: What the user needs to do
- icon_url: Optional icon (NULL for now)
- points: Points awarded (10-150)
```

### Test Achievements
1. **First Steps** (10 pts) - Complete the tutorial
2. **Beginner** (20 pts) - Reach level 5
3. **Intermediate** (30 pts) - Reach level 10
4. **Advanced** (50 pts) - Reach level 25
5. **Master** (100 pts) - Reach level 50
6. **Speedrunner** (25 pts) - Complete level in <30s
7. **Explorer** (40 pts) - Find all hidden areas
8. **Perfectionist** (150 pts) - 100% completion

## API Endpoints

### Get All Games (Auth Required)
```
GET /games
```

Returns list of active games.

### Get Game Stats (Auth Required)
```
GET /games/:gameSlug/stats
```

Returns:
- Game info
- All achievements (locked/unlocked)
- User's custom stats
- Progress summary (completion %, points, etc.)

### Admin: Create Game
```
POST /admin/games
Authorization: Bearer {admin_token}

{
  "name": "Game Name",
  "slug": "game-slug",
  "description": "Game description",
  "icon_url": "https://..."
}
```

### Admin: Create Achievement
```
POST /admin/games/:gameSlug/achievements
Authorization: Bearer {admin_token}

{
  "name": "Achievement Name",
  "description": "How to unlock",
  "icon_url": "https://...",
  "points": 25
}
```

## Frontend Routes

- `/stats` - Game selection (shows "Coming Soon!" for non-admins)
- `/stats/:gameSlug` - View stats for a specific game
- Dashboard has "Game Stats" button in sidebar

## Unlocking Achievements (For Game Integration)

When a game wants to unlock an achievement for a user, you'll need to:

```sql
-- Insert into user_achievements
INSERT INTO user_achievements (id, user_id, achievement_id, unlocked_at)
VALUES ('{uuid}', '{user_id}', '{achievement_id}', unixepoch());
```

Or create a backend endpoint:
```
POST /games/:gameSlug/achievements/:achievementId/unlock
Authorization: Bearer {user_token}
```

## Custom Game Stats

Games can store custom statistics using JSON in `user_game_stats.stats_data`:

```json
{
  "high_score": 1500,
  "games_played": 42,
  "wins": 28,
  "losses": 14,
  "time_played_seconds": 7200
}
```

These will automatically display in the "Game Statistics" section on the stats page.

## Next Steps

1. Apply migrations: `wrangler d1 migrations apply qti_auth --remote`
2. Seed test data: `wrangler d1 execute qti_auth --remote --file=./schema-games.sql`
3. Deploy worker: `wrangler deploy`
4. Build frontend: `cd frontend && npm run build`
5. Test with admin account at `/stats`

## Future Enhancements

- Leaderboards
- Achievement rarity percentages
- Social features (share achievements)
- Achievement notifications
- Global stats across all games
- Game-specific badges/titles

