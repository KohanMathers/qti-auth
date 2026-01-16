# JagSMP - Minecraft Account Linking Setup Guide

This guide explains how to set up and use the JagSMP Minecraft account linking feature.

## Overview

JagSMP allows users to link their Minecraft accounts to their QTI Auth accounts, enabling:
- View playtime and activity statistics
- Track PvP combat stats (kills, deaths, K/D ratio)
- Unlock and display server achievements
- View recent activity feed
- Secure account linking with time-limited codes

## Database Schema

The feature uses several new tables (see [migrations/0004_jagsmp_minecraft_linking.sql](migrations/0004_jagsmp_minecraft_linking.sql)):

- **minecraft_accounts**: Stores linked Minecraft accounts
- **minecraft_link_codes**: Temporary codes for account verification (10-minute expiry)
- **minecraft_unlink_cooldowns**: Tracks unlinking cooldowns (7-day cooldown)
- **minecraft_player_stats**: Player statistics from the server
- **minecraft_achievements**: Server-specific achievements
- **minecraft_player_achievements**: Tracks unlocked achievements
- **minecraft_activity_log**: Recent activity feed

## API Endpoints

### For Users (Frontend)

#### `GET /jagsmp/me`
Get user's linked Minecraft account and stats.

**Auth**: Required (JWT token)

**Response**:
```json
{
  "linked": true,
  "account": {
    "minecraft_username": "Steve",
    "minecraft_uuid": "069a79f4-44e9-4726-a5be-fca90e38aaf5",
    "linked_at": 1234567890,
    "last_updated": 1234567890
  },
  "stats": {
    "playtime_hours": 50,
    "playtime_minutes": 30,
    "first_joined": 1234567890,
    "last_seen": 1234567890,
    "total_sessions": 150,
    "player_kills": 42,
    "deaths": 20,
    "kdr": 2.1,
    "mob_kills": 500,
    "damage_dealt": 10000.5,
    "damage_taken": 5000.25,
    "additional_stats": {}
  },
  "achievements": {
    "total_unlocked": 5,
    "total_points": 150,
    "recent": [...]
  },
  "recent_activity": [...]
}
```

#### `POST /jagsmp/link`
Link a Minecraft account using a code from `/qtilink` command.

**Auth**: Required (JWT token)

**Request**:
```json
{
  "code": "ABC123"
}
```

**Response**:
```json
{
  "message": "Minecraft account linked successfully",
  "minecraft_username": "Steve",
  "minecraft_uuid": "069a79f4-44e9-4726-a5be-fca90e38aaf5"
}
```

**Error Cases**:
- Already has a linked account
- Code invalid/expired/used
- Account already linked to another user
- On cooldown from previous unlink

#### `POST /jagsmp/unlink`
Unlink current Minecraft account (enforces 7-day cooldown).

**Auth**: Required (JWT token)

**Response**:
```json
{
  "message": "Minecraft account unlinked successfully",
  "cooldown_ends_at": 1234567890,
  "can_link_again_in_days": 7
}
```

#### `GET /jagsmp/achievements`
Get all available achievements (non-secret).

**Auth**: None required

**Response**:
```json
{
  "achievements": {
    "playtime": [...],
    "pvp": [...],
    "milestone": [...]
  }
}
```

### For Minecraft Plugin

All plugin endpoints require `MINECRAFT_PLUGIN_SECRET` environment variable for authentication.

#### `POST /jagsmp/generate-code`
Generate a new link code (called by `/qtilink` command).

**Request**:
```json
{
  "plugin_secret": "your-secret-key",
  "minecraft_uuid": "069a79f4-44e9-4726-a5be-fca90e38aaf5",
  "minecraft_username": "Steve"
}
```

**Response**:
```json
{
  "code": "ABC123",
  "expires_in_seconds": 600,
  "message": "Enter this code on the website to link your account"
}
```

#### `POST /jagsmp/plugin/update-stats`
Update player statistics.

**Request**:
```json
{
  "plugin_secret": "your-secret-key",
  "minecraft_uuid": "069a79f4-44e9-4726-a5be-fca90e38aaf5",
  "stats": {
    "total_playtime_minutes": 3030,
    "total_sessions": 150,
    "player_kills": 42,
    "deaths": 20,
    "mob_kills": 500,
    "damage_dealt": 10000.5,
    "damage_taken": 5000.25,
    "first_joined": 1234567890,
    "additional": {
      "custom_stat": "value"
    }
  }
}
```

#### `POST /jagsmp/plugin/log-activity`
Log a player activity event.

**Request**:
```json
{
  "plugin_secret": "your-secret-key",
  "minecraft_uuid": "069a79f4-44e9-4726-a5be-fca90e38aaf5",
  "activity_type": "login",
  "activity_data": {
    "server": "survival",
    "ip": "127.0.0.1"
  }
}
```

**Activity Types**: `login`, `logout`, `achievement`, `death`, `kill`, etc.

#### `POST /jagsmp/plugin/unlock-achievement`
Unlock an achievement for a player.

**Request**:
```json
{
  "plugin_secret": "your-secret-key",
  "minecraft_uuid": "069a79f4-44e9-4726-a5be-fca90e38aaf5",
  "achievement_key": "first_kill"
}
```

**Response**:
```json
{
  "message": "Achievement unlocked",
  "achievement": {
    "name": "First Blood",
    "points": 15
  }
}
```

## Deployment Steps

### 1. Run Database Migration

Apply the migration to create the necessary tables:

```bash
wrangler d1 execute qti-auth --file=migrations/0004_jagsmp_minecraft_linking.sql
```

### 2. Set Plugin Secret

Generate a secure random string and set it as an environment variable:

```bash
# Generate a random secret (example)
openssl rand -hex 32

# Set it as a Cloudflare secret
wrangler secret put MINECRAFT_PLUGIN_SECRET
```

### 3. Deploy Backend

```bash
npm run deploy
```

### 4. Deploy Frontend

```bash
cd frontend
npm run build
npm run deploy
```

## Minecraft Plugin Implementation

You'll need to create a Spigot/Paper plugin that:

1. Implements `/qtilink` command that:
   - Calls `POST /jagsmp/generate-code` with player's UUID and username
   - Displays the code to the player in chat
   - Includes a clickable link to the website

2. Tracks player statistics:
   - Playtime (using login/logout events)
   - Combat stats (using PlayerDeathEvent, EntityDamageByEntityEvent)
   - Sessions count
   - Periodically calls `POST /jagsmp/plugin/update-stats` (e.g., every 5 minutes)

3. Logs player activity:
   - Login/logout events
   - Achievement unlocks
   - Deaths/kills
   - Calls `POST /jagsmp/plugin/log-activity`

4. Manages achievements:
   - Check for achievement conditions
   - Call `POST /jagsmp/plugin/unlock-achievement` when unlocked
   - Display in-game notifications

### Example Plugin Code Structure (Java/Spigot)

```java
public class QTILinkPlugin extends JavaPlugin {
    private String apiUrl = "https://auth.quietterminal.co.uk";
    private String pluginSecret = "your-secret-key";

    @Override
    public void onEnable() {
        getCommand("qtilink").setExecutor(new LinkCommand(this));
        getServer().getPluginManager().registerEvents(new PlayerListener(this), this);

        // Start stats updater task (every 5 minutes)
        new StatsUpdater(this).runTaskTimerAsynchronously(this, 6000L, 6000L);
    }

    public void generateLinkCode(Player player) {
        // Call API endpoint
        JsonObject request = new JsonObject();
        request.addProperty("plugin_secret", pluginSecret);
        request.addProperty("minecraft_uuid", player.getUniqueId().toString());
        request.addProperty("minecraft_username", player.getName());

        // Make HTTP POST request to /jagsmp/generate-code
        // Display code to player
    }

    public void updatePlayerStats(Player player) {
        // Gather stats and call /jagsmp/plugin/update-stats
    }

    public void logActivity(UUID uuid, String activityType, JsonObject data) {
        // Call /jagsmp/plugin/log-activity
    }

    public void unlockAchievement(UUID uuid, String achievementKey) {
        // Call /jagsmp/plugin/unlock-achievement
    }
}
```

## Frontend Usage

Users can access the JagSMP page at `/jagsmp` after logging in.

**Linking Flow**:
1. User logs into QTI Auth website
2. User navigates to Dashboard → JagSMP
3. User joins Minecraft server
4. User runs `/qtilink` command
5. Plugin generates a 6-character code (expires in 10 minutes)
6. User enters code on website
7. Account is linked and stats are displayed

**Unlinking**:
- Users can unlink their account (7-day cooldown applies)
- During cooldown, they cannot link a new account
- Previous account data is preserved in cooldown table

## Security Features

- **Plugin Secret**: All plugin endpoints require shared secret authentication
- **Code Expiry**: Link codes expire after 10 minutes
- **One-time Use**: Codes can only be used once
- **Cooldown Protection**: 7-day cooldown prevents account swapping abuse
- **UUID Verification**: Uses Minecraft UUIDs (not usernames) for secure identification
- **Account Uniqueness**: One Minecraft account per QTI account, one QTI account per Minecraft account

## Default Achievements

The migration includes several default achievements:

| Achievement | Description | Category | Points |
|------------|-------------|----------|--------|
| Welcome to JagSMP! | Join the server for the first time | milestone | 10 |
| Getting Started | Play for 1 hour | playtime | 15 |
| Regular Player | Play for 10 hours | playtime | 25 |
| Dedicated Member | Play for 50 hours | playtime | 50 |
| Server Veteran | Play for 100 hours | playtime | 100 |
| First Blood | Get your first player kill | pvp | 15 |
| On Fire! | Get 5 kills without dying | pvp | 30 |
| Untouchable | Play for 5 hours without dying | pvp | 50 |
| Warrior | Achieve a 2.0 K/D ratio with at least 50 kills | pvp | 40 |

## Monitoring & Maintenance

- Monitor `minecraft_link_codes` table for expired codes (clean up periodically)
- Monitor `minecraft_activity_log` table size (consider archiving old entries)
- Track API usage from plugin to ensure it's functioning correctly
- Review achievement unlock rates to balance difficulty

## Troubleshooting

**"Code expired" error**:
- Codes expire after 10 minutes
- User should generate a new code with `/qtilink`

**"Account already linked" error**:
- Minecraft account is already linked to another user
- Contact admin if this is incorrect

**"Cooldown active" error**:
- User unlinked an account recently
- Must wait 7 days before linking a new account

**Stats not updating**:
- Check plugin is running and making API calls
- Verify `MINECRAFT_PLUGIN_SECRET` is set correctly
- Check API logs for errors

**Plugin authentication failing**:
- Verify `MINECRAFT_PLUGIN_SECRET` matches on both sides
- Check secret was set with `wrangler secret put`
- Ensure secret is not accidentally committed to git

## Future Enhancements

Potential features to add:

- Leaderboards (top players by playtime, K/D, achievements)
- Player vs player comparison
- Server-wide statistics
- Custom stat tracking (blocks placed, items crafted, etc.)
- Achievement categories and filters
- Public profiles (shareable links)
- Discord integration (display MC stats in Discord)
- Server status and online players
- Economy integration (if server has economy plugin)

## Support

For issues or questions:
- Check API logs: `wrangler tail`
- Check D1 database: `wrangler d1 execute qti-auth --command="SELECT * FROM minecraft_accounts"`
- Review migration: [migrations/0004_jagsmp_minecraft_linking.sql](migrations/0004_jagsmp_minecraft_linking.sql)
- API source code: [worker.js](worker.js) (lines 1655-2133)
- Frontend source code: [frontend/src/pages/JagSMP.jsx](frontend/src/pages/JagSMP.jsx)
