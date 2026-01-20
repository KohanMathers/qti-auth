export async function handleScheduled(event, env, ctx) {
  const db = env.DB;
  const currentTime = Math.floor(Date.now() / 1000);

  try {
    // Staggered retention windows keep storage tidy without aggressive churn.
    const thirtyDaysAgo = currentTime - (30 * 24 * 60 * 60);
    await db.prepare(
      'DELETE FROM user_sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)'
    ).bind(thirtyDaysAgo, thirtyDaysAgo).run();

    const ninetyDaysAgo = currentTime - (90 * 24 * 60 * 60);
    await db.prepare(
      'DELETE FROM session_security_events WHERE created_at < ?'
    ).bind(ninetyDaysAgo).run();

    const oneHourAgo = currentTime - 3600;
    await db.prepare('DELETE FROM oauth_states WHERE created_at < ?').bind(oneHourAgo).run();
    await db.prepare('DELETE FROM oauth_temp WHERE created_at < ?').bind(oneHourAgo).run();

    const oneDayAgo = currentTime - (24 * 60 * 60);
    await db.prepare('DELETE FROM mail_rate_limits WHERE timestamp < ?').bind(oneDayAgo).run();
    await db.prepare('DELETE FROM email_tokens WHERE expires_at < ?').bind(oneDayAgo).run();

    console.log('Scheduled cleanup completed successfully');
  } catch (e) {
    console.error('Scheduled cleanup failed:', e);
  }
}
