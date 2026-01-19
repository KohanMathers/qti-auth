import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import ThemeToggle from '../components/ThemeToggle';

function Stats({ user }) {
  const [games, setGames] = useState([]);
  const [selectedGame, setSelectedGame] = useState(null);
  const [gameStats, setGameStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const { gameSlug } = useParams();

  useEffect(() => {
    fetchGames();
  }, []);

  useEffect(() => {
    if (gameSlug && games.length > 0) {
      const game = games.find(g => g.slug === gameSlug);
      if (game) {
        setSelectedGame(game);
        fetchGameStats(gameSlug);
      }
    }
  }, [gameSlug, games]);

  const fetchGames = async () => {
    const token = localStorage.getItem('qti_token');
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/games`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      setGames(data.games || []);
    } catch (err) {
      console.error('Failed to fetch games:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchGameStats = async (slug) => {
    const token = localStorage.getItem('qti_token');
    setLoading(true);
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/games/${slug}/stats`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      setGameStats(data);
    } catch (err) {
      console.error('Failed to fetch game stats:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleGameSelect = (game) => {
    navigate(`/stats/${game.slug}`);
  };

  const handleBack = () => {
    navigate('/dashboard');
  };

  if (loading && games.length === 0) {
    return (
      <div className="loading-screen">
        <div className="spinner"></div>
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <div className="dashboard-container">
      <ThemeToggle />
      <header className="dashboard-header">
        <div className="header-content">
          <h1>QTI Auth</h1>
          <div className="user-info">
            <span className="username">{user?.username_original || user?.username || 'User'}</span>
            <button onClick={handleBack} className="btn-secondary">Back to Dashboard</button>
          </div>
        </div>
      </header>

      <div className="stats-container">
        {!selectedGame ? (
          <div className="game-selection">
            <h2>Select a Game</h2>
            {games.length === 0 ? (
              <div className="empty-state">
                <h3>🎮 Coming Soon!</h3>
                <p>Game stats will be available once you start playing QTI games.</p>
                <p className="help-text">Check back later for achievements, leaderboards, and more!</p>
              </div>
            ) : (
              <div className="games-grid">
                {games.map(game => (
                  <button
                    key={game.id}
                    className="game-card"
                    onClick={() => handleGameSelect(game)}
                  >
                    {game.icon_url && <img src={game.icon_url} alt={game.name} className="game-icon" />}
                    <div className="game-info">
                      <h3>{game.name}</h3>
                      <p>{game.description}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="game-stats">
            <div className="stats-header">
              <button onClick={() => { setSelectedGame(null); setGameStats(null); navigate('/stats'); }} className="btn-secondary">
                ← Back to Games
              </button>
              <div className="game-title">
                {selectedGame.icon_url && <img src={selectedGame.icon_url} alt={selectedGame.name} className="game-icon-large" />}
                <h2>{selectedGame.name}</h2>
              </div>
            </div>

            {loading ? (
              <div className="loading-screen">
                <div className="spinner"></div>
              </div>
            ) : gameStats ? (
              <div className="stats-content">
                {/* Progress Overview */}
                <div className="progress-card">
                  <h3>Achievement Progress</h3>
                  <div className="progress-stats">
                    <div className="stat-item">
                      <span className="stat-value">{gameStats.progress.unlocked_achievements}</span>
                      <span className="stat-label">/ {gameStats.progress.total_achievements} Unlocked</span>
                    </div>
                    <div className="stat-item">
                      <span className="stat-value">{gameStats.progress.earned_points}</span>
                      <span className="stat-label">/ {gameStats.progress.total_points} Points</span>
                    </div>
                    <div className="stat-item">
                      <span className="stat-value">{gameStats.progress.completion_percentage}%</span>
                      <span className="stat-label">Complete</span>
                    </div>
                  </div>
                  <div className="progress-bar">
                    <div
                      className="progress-fill"
                      style={{ width: `${gameStats.progress.completion_percentage}%` }}
                    ></div>
                  </div>
                </div>

                {/* Achievements */}
                <div className="achievements-section">
                  <h3>Achievements</h3>
                  {gameStats.achievements.length === 0 ? (
                    <p className="help-text">No achievements available yet.</p>
                  ) : (
                    <div className="achievements-list">
                      {gameStats.achievements.map(achievement => (
                        <div
                          key={achievement.id}
                          className={`achievement-card ${achievement.unlocked ? 'unlocked' : 'locked'}`}
                        >
                          {achievement.icon_url && (
                            <img src={achievement.icon_url} alt={achievement.name} className="achievement-icon" />
                          )}
                          <div className="achievement-info">
                            <h4>{achievement.name}</h4>
                            <p>{achievement.description}</p>
                            <div className="achievement-meta">
                              <span className="points">{achievement.points} pts</span>
                              {achievement.unlocked && achievement.unlocked_at && (
                                <span className="unlocked-date">
                                  Unlocked {new Date(achievement.unlocked_at * 1000).toLocaleDateString()}
                                </span>
                              )}
                            </div>
                          </div>
                          {achievement.unlocked ? (
                            <span className="unlock-badge">✓</span>
                          ) : (
                            <span className="lock-badge">🔒</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Custom Game Stats */}
                {Object.keys(gameStats.stats).length > 0 && (
                  <div className="custom-stats-section">
                    <h3>Game Statistics</h3>
                    <div className="stats-grid">
                      {Object.entries(gameStats.stats).map(([key, value]) => (
                        <div key={key} className="stat-box">
                          <span className="stat-label">{key.replace(/_/g, ' ').toUpperCase()}</span>
                          <span className="stat-value">{value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <p>Failed to load stats.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default Stats;
