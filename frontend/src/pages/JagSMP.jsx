import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

function JagSMP({ user }) {
  const navigate = useNavigate();
  const [linkData, setLinkData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [linkCode, setLinkCode] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState(false);

  useEffect(() => {
    fetchLinkStatus();
  }, []);

  const fetchLinkStatus = async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem('qti_token');
      const response = await fetch(`${import.meta.env.VITE_API_URL}/jagsmp/me`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      const data = await response.json();
      setLinkData(data);
    } catch (err) {
      setError('Failed to load account status');
    } finally {
      setLoading(false);
    }
  };

  const handleLink = async (e) => {
    e.preventDefault();
    setLinking(true);
    setError('');
    setSuccess('');

    try {
      const token = localStorage.getItem('qti_token');
      const response = await fetch(`${import.meta.env.VITE_API_URL}/jagsmp/link`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ code: linkCode.toUpperCase() }),
      });

      const data = await response.json();

      if (response.ok) {
        setSuccess(`Successfully linked account: ${data.minecraft_username}`);
        setLinkCode('');
        setTimeout(() => {
          fetchLinkStatus();
        }, 1000);
      } else {
        setError(data.error || 'Failed to link account');
        if (data.remaining_days) {
          setError(`${data.error} (${data.remaining_days} days remaining)`);
        }
      }
    } catch (err) {
      setError('Network error. Please try again.');
    } finally {
      setLinking(false);
    }
  };

  const handleUnlink = async () => {
    if (!confirm('Are you sure you want to unlink your Minecraft account? You will need to wait 7 days before linking another account.')) {
      return;
    }

    setUnlinking(true);
    setError('');
    setSuccess('');

    try {
      const token = localStorage.getItem('qti_token');
      const response = await fetch(`${import.meta.env.VITE_API_URL}/jagsmp/unlink`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      const data = await response.json();

      if (response.ok) {
        setSuccess('Account unlinked successfully. You can link a new account in 7 days.');
        setTimeout(() => {
          fetchLinkStatus();
        }, 1000);
      } else {
        setError(data.error || 'Failed to unlink account');
      }
    } catch (err) {
      setError('Network error. Please try again.');
    } finally {
      setUnlinking(false);
    }
  };

  const formatDate = (timestamp) => {
    if (!timestamp) return 'Never';
    const date = new Date(timestamp * 1000);
    return date.toLocaleString();
  };

  const formatDuration = (minutes) => {
    if (!minutes) return '0m';
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hours === 0) return `${mins}m`;
    return `${hours}h ${mins}m`;
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="page-header">
          <button className="back-btn" onClick={() => navigate('/dashboard')}>← Back</button>
          <h1>JagSMP</h1>
        </div>
        <div className="loading-container">
          <div className="spinner"></div>
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <button className="back-btn" onClick={() => navigate('/dashboard')}>← Back</button>
        <h1>JagSMP - Minecraft Account</h1>
      </div>

      {error && <div className="error-message">{error}</div>}
      {success && <div className="success-message">{success}</div>}

      {!linkData?.linked ? (
        <div className="link-section">
          <div className="info-card">
            <h2>Link Your Minecraft Account</h2>
            <p>Connect your Minecraft account to view your stats and achievements on JagSMP.</p>

            <div className="instructions">
              <h3>How to Link:</h3>
              <ol>
                <li>Join the JagSMP Minecraft server</li>
                <li>Run the command: <code>/qtilink</code></li>
                <li>Copy the code you receive</li>
                <li>Paste it below and click "Link Account"</li>
              </ol>
            </div>

            <form onSubmit={handleLink} className="link-form">
              <div className="form-group">
                <label htmlFor="linkCode">Link Code</label>
                <input
                  type="text"
                  id="linkCode"
                  value={linkCode}
                  onChange={(e) => setLinkCode(e.target.value.toUpperCase())}
                  placeholder="Enter 6-character code"
                  maxLength={6}
                  required
                  style={{ textTransform: 'uppercase', fontSize: '1.2em', letterSpacing: '0.2em' }}
                />
                <small>The code expires in 10 minutes</small>
              </div>

              <button type="submit" disabled={linking || linkCode.length !== 6} className="primary-btn">
                {linking ? 'Linking...' : 'Link Account'}
              </button>
            </form>
          </div>
        </div>
      ) : (
        <div className="stats-section">
          {/* Account Info Card */}
          <div className="info-card">
            <div className="card-header">
              <h2>Linked Account</h2>
              <button onClick={handleUnlink} disabled={unlinking} className="danger-btn-small">
                {unlinking ? 'Unlinking...' : 'Unlink'}
              </button>
            </div>
            <div className="account-info">
              <div className="mc-avatar">
                <img
                  src={`http://cravatar.eu/avatar/${linkData.account.minecraft_uuid}/128.png`}
                  alt={linkData.account.minecraft_username}
                />
              </div>
              <div className="account-details">
                <h3>{linkData.account.minecraft_username}</h3>
                <p className="text-muted">Linked {formatDate(linkData.account.linked_at)}</p>
              </div>
            </div>
          </div>

          {/* Stats Cards Grid */}
          <div className="stats-grid">
            {/* Playtime Card */}
            <div className="stat-card">
              <div className="stat-icon">⏱️</div>
              <h3>Playtime</h3>
              <div className="stat-value">
                {linkData.stats.playtime_hours}h {linkData.stats.playtime_minutes}m
              </div>
              <div className="stat-meta">
                <p>First joined: {formatDate(linkData.stats.first_joined)}</p>
                <p>Last seen: {formatDate(linkData.stats.last_seen)}</p>
                <p>Total sessions: {linkData.stats.total_sessions}</p>
              </div>
            </div>

            {/* PvP Stats Card */}
            <div className="stat-card">
              <div className="stat-icon">⚔️</div>
              <h3>Combat Stats</h3>
              <div className="stat-value">K/D: {linkData.stats.kdr}</div>
              <div className="stat-meta">
                <p>Kills: {linkData.stats.player_kills}</p>
                <p>Deaths: {linkData.stats.deaths}</p>
                <p>Mob kills: {linkData.stats.mob_kills}</p>
              </div>
            </div>

            {/* Achievements Card */}
            <div className="stat-card">
              <div className="stat-icon">🏆</div>
              <h3>Achievements</h3>
              <div className="stat-value">{linkData.achievements.total_unlocked}</div>
              <div className="stat-meta">
                <p>Total points: {linkData.achievements.total_points}</p>
              </div>
            </div>

            {/* Damage Stats Card */}
            <div className="stat-card">
              <div className="stat-icon">💥</div>
              <h3>Damage</h3>
              <div className="stat-value">{Math.round(linkData.stats.damage_dealt).toLocaleString()}</div>
              <div className="stat-meta">
                <p>Dealt: {Math.round(linkData.stats.damage_dealt).toLocaleString()}</p>
                <p>Taken: {Math.round(linkData.stats.damage_taken).toLocaleString()}</p>
                <p>Blocked: {Math.round(linkData.stats.damage_blocked_by_shield || 0).toLocaleString()}</p>
                <p>Resisted: {Math.round(linkData.stats.damage_resisted || 0).toLocaleString()}</p>
                <p>Absorbed: {Math.round(linkData.stats.damage_absorbed || 0).toLocaleString()}</p>
              </div>
            </div>
          </div>

          {/* Current Session Info */}
          {linkData.stats.current_session && linkData.stats.current_session.login_timestamp > 0 && (
            <div className="info-card">
              <h2>Current Session</h2>
              <div className="stats-grid">
                <div className="stat-item">
                  <span className="stat-label">Session Duration:</span>
                  <span className="stat-value">{formatDuration(Math.floor(linkData.stats.current_session.session_duration_seconds / 60))}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Logged in:</span>
                  <span className="stat-value">{formatDate(linkData.stats.current_session.login_timestamp)}</span>
                </div>
              </div>
            </div>
          )}

          {/* Movement Stats */}
          {linkData.stats.movement && (
            <div className="info-card">
              <h2>Movement Stats (meters)</h2>
              <div className="stats-grid">
                <div className="stat-item">
                  <span className="stat-label">Walked:</span>
                  <span className="stat-value">{Math.round(linkData.stats.movement.distance_walked || 0).toLocaleString()}m</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Sprinted:</span>
                  <span className="stat-value">{Math.round(linkData.stats.movement.distance_sprinted || 0).toLocaleString()}m</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Crouched:</span>
                  <span className="stat-value">{Math.round(linkData.stats.movement.distance_crouched || 0).toLocaleString()}m</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Flown:</span>
                  <span className="stat-value">{Math.round(linkData.stats.movement.distance_flown || 0).toLocaleString()}m</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Climbed:</span>
                  <span className="stat-value">{Math.round(linkData.stats.movement.distance_climbed || 0).toLocaleString()}m</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Fallen:</span>
                  <span className="stat-value">{Math.round(linkData.stats.movement.distance_fallen || 0).toLocaleString()}m</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Swam:</span>
                  <span className="stat-value">{Math.round(linkData.stats.movement.distance_swam || 0).toLocaleString()}m</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Minecart:</span>
                  <span className="stat-value">{Math.round(linkData.stats.movement.distance_minecart || 0).toLocaleString()}m</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Boat:</span>
                  <span className="stat-value">{Math.round(linkData.stats.movement.distance_boat || 0).toLocaleString()}m</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Pig:</span>
                  <span className="stat-value">{Math.round(linkData.stats.movement.distance_pig || 0).toLocaleString()}m</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Horse:</span>
                  <span className="stat-value">{Math.round(linkData.stats.movement.distance_horse || 0).toLocaleString()}m</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Elytra:</span>
                  <span className="stat-value">{Math.round(linkData.stats.movement.distance_elytra || 0).toLocaleString()}m</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Jumps:</span>
                  <span className="stat-value">{(linkData.stats.movement.jumps || 0).toLocaleString()}</span>
                </div>
              </div>
            </div>
          )}

          {/* Interaction Stats */}
          {linkData.stats.interactions && (
            <div className="info-card">
              <h2>Interaction Stats</h2>
              <div className="stats-grid">
                <div className="stat-item">
                  <span className="stat-label">Times Slept:</span>
                  <span className="stat-value">{(linkData.stats.interactions.times_slept || 0).toLocaleString()}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Barrels Opened:</span>
                  <span className="stat-value">{(linkData.stats.interactions.barrels_opened || 0).toLocaleString()}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Ender Chests Opened:</span>
                  <span className="stat-value">{(linkData.stats.interactions.ender_chests_opened || 0).toLocaleString()}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Items Enchanted:</span>
                  <span className="stat-value">{(linkData.stats.interactions.items_enchanted || 0).toLocaleString()}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Animals Bred:</span>
                  <span className="stat-value">{(linkData.stats.interactions.animals_bred || 0).toLocaleString()}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Fish Caught:</span>
                  <span className="stat-value">{(linkData.stats.interactions.fish_caught || 0).toLocaleString()}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Traded with Villager:</span>
                  <span className="stat-value">{(linkData.stats.interactions.traded_with_villager || 0).toLocaleString()}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Talked to Villager:</span>
                  <span className="stat-value">{(linkData.stats.interactions.talked_to_villager || 0).toLocaleString()}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Cake Slices Eaten:</span>
                  <span className="stat-value">{(linkData.stats.interactions.cake_slices_eaten || 0).toLocaleString()}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Bells Rung:</span>
                  <span className="stat-value">{(linkData.stats.interactions.bells_rung || 0).toLocaleString()}</span>
                </div>
              </div>
            </div>
          )}

          {/* Building/Crafting Stats */}
          {linkData.stats.building && (
            <div className="info-card">
              <h2>Building & Crafting Stats</h2>
              <div className="stats-grid">
                <div className="stat-item">
                  <span className="stat-label">Items Crafted:</span>
                  <span className="stat-value">{(linkData.stats.building.items_crafted || 0).toLocaleString()}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Beacons Interacted:</span>
                  <span className="stat-value">{(linkData.stats.building.beacons_interacted || 0).toLocaleString()}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Anvils Used:</span>
                  <span className="stat-value">{(linkData.stats.building.anvils_used || 0).toLocaleString()}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Lecterns Interacted:</span>
                  <span className="stat-value">{(linkData.stats.building.lecterns_interacted || 0).toLocaleString()}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Grindstones Interacted:</span>
                  <span className="stat-value">{(linkData.stats.building.grindstones_interacted || 0).toLocaleString()}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Looms Interacted:</span>
                  <span className="stat-value">{(linkData.stats.building.looms_interacted || 0).toLocaleString()}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Smithing Tables Interacted:</span>
                  <span className="stat-value">{(linkData.stats.building.smithing_tables_interacted || 0).toLocaleString()}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Stonecutters Interacted:</span>
                  <span className="stat-value">{(linkData.stats.building.stonecutters_interacted || 0).toLocaleString()}</span>
                </div>
              </div>
            </div>
          )}

          {/* Misc Stats */}
          {linkData.stats.misc && (
            <div className="info-card">
              <h2>Miscellaneous Stats</h2>
              <div className="stats-grid">
                <div className="stat-item">
                  <span className="stat-label">Raids Triggered:</span>
                  <span className="stat-value">{(linkData.stats.misc.raids_triggered || 0).toLocaleString()}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Raids Won:</span>
                  <span className="stat-value">{(linkData.stats.misc.raids_won || 0).toLocaleString()}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Targets Hit:</span>
                  <span className="stat-value">{(linkData.stats.misc.targets_hit || 0).toLocaleString()}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Time Since Rest:</span>
                  <span className="stat-value">{formatDuration(linkData.stats.misc.time_since_rest || 0)}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Time Since Death:</span>
                  <span className="stat-value">{formatDuration(linkData.stats.misc.time_since_death || 0)}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Flowers Potted:</span>
                  <span className="stat-value">{(linkData.stats.misc.flower_potted || 0).toLocaleString()}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Armor Pieces Cleaned:</span>
                  <span className="stat-value">{(linkData.stats.misc.armor_pieces_cleaned || 0).toLocaleString()}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Banners Cleaned:</span>
                  <span className="stat-value">{(linkData.stats.misc.banners_cleaned || 0).toLocaleString()}</span>
                </div>
              </div>
            </div>
          )}

          {/* Recent Achievements */}
          {linkData.achievements.recent && linkData.achievements.recent.length > 0 && (
            <div className="info-card">
              <h2>Recent Achievements</h2>
              <div className="achievements-list">
                {linkData.achievements.recent.map((achievement) => (
                  <div key={achievement.id} className="achievement-item">
                    {achievement.icon_url && (
                      <img src={achievement.icon_url} alt={achievement.name} className="achievement-icon" />
                    )}
                    <div className="achievement-info">
                      <h4>{achievement.name}</h4>
                      <p>{achievement.description}</p>
                      <span className="achievement-meta">
                        {achievement.points} points • Unlocked {formatDate(achievement.unlocked_at)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Recent Activity */}
          {linkData.recent_activity && linkData.recent_activity.length > 0 && (
            <div className="info-card">
              <h2>Recent Activity</h2>
              <div className="activity-list">
                {linkData.recent_activity.slice(0, 10).map((activity, index) => {
                  const activityData = activity.activity_data ? JSON.parse(activity.activity_data) : {};
                  return (
                    <div key={index} className="activity-item">
                      <div className="activity-type">
                        {activity.activity_type === 'login' && '🟢'}
                        {activity.activity_type === 'logout' && '🔴'}
                        {activity.activity_type === 'achievement' && '🏆'}
                        {activity.activity_type === 'death' && '💀'}
                        {activity.activity_type === 'kill' && '⚔️'}
                        {!['login', 'logout', 'achievement', 'death', 'kill'].includes(activity.activity_type) && '📝'}
                      </div>
                      <div className="activity-info">
                        <span className="activity-description">
                          {activity.activity_type === 'achievement' && `Unlocked: ${activityData.achievement_name}`}
                          {activity.activity_type === 'login' && 'Joined the server'}
                          {activity.activity_type === 'logout' && 'Left the server'}
                          {activity.activity_type === 'death' && 'Died'}
                          {activity.activity_type === 'kill' && 'Got a kill'}
                          {!['login', 'logout', 'achievement', 'death', 'kill'].includes(activity.activity_type) &&
                            activity.activity_type.replace(/_/g, ' ')}
                        </span>
                        <span className="activity-time">{formatDate(activity.occurred_at)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default JagSMP;
